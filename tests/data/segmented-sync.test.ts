// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  clampChanges,
  continuityOf,
  type DeltaStage,
  maxChangesFor,
  SEGMENT_CONTRACT,
  stageOf,
} from "../../src/data/model/segmented-sync";
import { next as nextSizing } from "../../src/data/model/sizing";
import type { SizingState } from "../../src/data/model/types";
import type { CommitPageInput } from "../../src/data/plans/commit-page";
import { stageDeltaSegment } from "../../src/data/plans/delta-segments";
import { invalidateRecoveryPosition } from "../../src/data/plans/sync-writers";
import { scanSyncPage } from "../../src/data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
} from "../../src/data/scan/validate";
import { type PageWorld, pageWorld } from "../support/data/page-world";
import {
  cacheRow,
  draftRow,
  effectRow,
  versionRow,
} from "../support/data/rows";
import {
  bytesOf,
  type Change,
  projection,
  Rng,
  uuid,
} from "../support/data/sync-pages";

/**
 * WEB-09c (BOUNDED-SYNC-PAGINATION-20261027): segmented delta delivery on the client, through the PRODUCTION plans over the double.
 * U1 the scan; U2 the adapter and the ladder; U3 a revision staged in segments and activated equals the whole batch, with what is in hand
 * bounded; U4 nothing partial is ever live and a failed activation leaves the stage intact; U5 a broken sequence applies nothing and starts
 * the revision again; U6 duplicates and late answers stage nothing twice; U7 every replacement of the position retires the stage; U8 local
 * work is reconciled exactly as for the whole batch (inside U3's comparison). The contract is BE-Q23's provisional one (`segmented-sync.ts`).
 */

const SEGMENTED = { ...DATA_CONFIG, allowSegment: true };
const decode = {
  validators: createValueValidators(),
  derivers: createKeyDerivers(),
};

interface SegmentSpec {
  revision: number;
  changes: Change[];
  segment?: { index: number; last: boolean };
  hasMore: boolean;
  nextCursor: string;
}

/** A delta page of one batch, with or without a segment member. */
const pageText = (spec: SegmentSpec): string =>
  JSON.stringify({
    phase: "delta",
    batches: [
      {
        revision: spec.revision,
        changes: spec.changes,
        ...(spec.segment ? { segment: spec.segment } : {}),
      },
    ],
    next_cursor: spec.nextCursor,
    has_more: spec.hasMore,
  });

/** The commit input of a page, scanned as a request that opted in would scan it, captured at the world's current position. */
function inputOf(
  w: PageWorld,
  spec: SegmentSpec | string,
  over: Partial<CommitPageInput> = {},
): CommitPageInput {
  const bytes = bytesOf(typeof spec === "string" ? spec : pageText(spec));
  const scan = scanSyncPage(bytes, SEGMENTED);
  if (!scan.ok) throw new Error(`the test page does not scan: ${scan.reason}`);
  return {
    captured: w.capture(),
    bytes,
    scan,
    now: "2026-10-01T12:00:00.000Z",
    decode,
    ...over,
  };
}

const stage = (w: PageWorld, input: CommitPageInput) =>
  w.service.commit(stageDeltaSegment, {
    captured: input.captured,
    bytes: input.bytes,
    scan: input.scan,
    now: 1_000,
    decode: input.decode,
  });

/** Splits a revision's changes into segments of at most `m`, as BE-Q23's server would, and returns the page specs in order. */
function segmentsOf(
  revision: number,
  changes: Change[],
  m: number,
  finalCursor = "final",
): SegmentSpec[] {
  const out: SegmentSpec[] = [];
  for (
    let from = 0, index = 0;
    from < changes.length || index === 0;
    index += 1
  ) {
    const slice = changes.slice(from, from + m);
    from += m;
    const last = from >= changes.length;
    out.push({
      revision,
      changes: slice,
      segment: { index, last },
      hasMore: !last,
      nextCursor: last ? finalCursor : `cont-${revision}-${index}`,
    });
    if (last) break;
  }
  return out;
}

/** Delivers a revision segment by segment through W27 and W1, and returns each outcome's value kind. */
async function deliver(
  w: PageWorld,
  segments: SegmentSpec[],
  over: Partial<CommitPageInput> = {},
): Promise<string[]> {
  const kinds: string[] = [];
  for (const spec of segments) {
    const input = inputOf(w, spec, over);
    const out =
      spec.segment?.last === false
        ? await stage(w, input)
        : await w.commit(input);
    kinds.push(
      out.kind === "applied" ? (out.value as { kind: string }).kind : out.kind,
    );
  }
  return kinds;
}

/**
 * A generated revision: `n` changes over a pool of ids smaller than `n` (so ids repeat, as ancestors repeated across segments do), each an
 * upsert with a rising version or, one time in five, a removal; some ids are upserted and then removed, some removed and then upserted.
 */
function revisionOf(seed: number, n: number): Change[] {
  const rng = new Rng(seed);
  const pool = Math.max(1, Math.floor(n * 0.7));
  return Array.from({ length: n }, (_, k) => {
    const id = uuid(1 + rng.int(pool));
    return rng.bool(0.2)
      ? { kind: "remove" as const, id }
      : {
          kind: "upsert" as const,
          resource: {
            ...projection(new Rng(seed * 1000 + k), k),
            id,
            version: k + 1,
          },
        };
  });
}

/** Local work over some of the ids, so the reconciliation of the activation is compared too (U8). */
function seedLocalWork(w: PageWorld): void {
  w.put("cache", [
    cacheRow({ id: uuid(1), version: 1 }),
    cacheRow({ id: uuid(900) }),
  ]);
  w.put("drafts", [
    // Explicit sequences and commands: the row builder's counter would otherwise give two worlds different drafts.
    draftRow({
      local_id: "d1",
      status: "acknowledged",
      index_targets: [uuid(2)],
      created_seq: 1,
      command: { kind: "edit", n: 1 },
    }),
    draftRow({
      local_id: "q1",
      status: "queued",
      index_targets: [uuid(3)],
      expected_version: 1,
      created_seq: 2,
      command: { kind: "edit", n: 2 },
    }),
  ]);
  w.put("pending_effects", [
    effectRow({
      resource_id: uuid(2),
      local_id: "d1",
      display: { label: "shown" },
      no_publication_floor: 1,
    }),
  ]);
  w.put("resource_versions", [
    versionRow({ resource_id: uuid(3), locally_assumed_version: 1 }),
  ]);
}

describe("U1: the scan reads a segment only where it was asked for", () => {
  const ok = (text: string, allow = true) =>
    scanSyncPage(bytesOf(text), allow ? SEGMENTED : DATA_CONFIG);
  const one = (
    batch: string,
    top = `"phase":"delta","next_cursor":"c","has_more":true`,
  ) => `{${top},"batches":[${batch}]}`;
  test("a well-formed segment is recorded on its batch; a whole page carries none", () => {
    const scan = ok(
      one(`{"revision":7,"changes":[],"segment":{"index":3,"last":false}}`),
    );
    expect(scan.ok && scan.batches).toEqual([
      { revision: 7, first: 0, count: 0, segment: { index: 3, last: false } },
    ]);
    const whole = ok(one(`{"revision":7,"changes":[]}`));
    expect(whole.ok && whole.batches[0]).toEqual({
      revision: 7,
      first: 0,
      count: 0,
    });
    const key = ok(
      one(`{"segment":{"last":true,"index":0},"changes":[],"revision":7}`),
    );
    expect(key.ok && key.batches[0]?.segment).toEqual({ index: 0, last: true });
  });
  test("without the option a segment is an unknown batch key, exactly as before", () => {
    expect(
      ok(
        one(`{"revision":7,"changes":[],"segment":{"index":0,"last":true}}`),
        false,
      ),
    ).toMatchObject({
      ok: false,
      stage: "structure",
      reason: "unknown batch key",
    });
  });
  test.each([
    [
      "a duplicate segment",
      `{"revision":7,"changes":[],"segment":{"index":0,"last":true},"segment":{"index":0,"last":true}}`,
    ],
    [
      "an extra key",
      `{"revision":7,"changes":[],"segment":{"index":0,"last":true,"more":1}}`,
    ],
    ["a missing last", `{"revision":7,"changes":[],"segment":{"index":0}}`],
    ["a missing index", `{"revision":7,"changes":[],"segment":{"last":true}}`],
    ["an empty segment", `{"revision":7,"changes":[],"segment":{}}`],
    [
      "a negative index",
      `{"revision":7,"changes":[],"segment":{"index":-1,"last":true}}`,
    ],
    [
      "a fractional index",
      `{"revision":7,"changes":[],"segment":{"index":1.5,"last":true}}`,
    ],
    [
      "an exponent index",
      `{"revision":7,"changes":[],"segment":{"index":1e2,"last":true}}`,
    ],
    [
      "a string index",
      `{"revision":7,"changes":[],"segment":{"index":"1","last":true}}`,
    ],
    [
      "a string last",
      `{"revision":7,"changes":[],"segment":{"index":0,"last":"true"}}`,
    ],
    [
      "a null last",
      `{"revision":7,"changes":[],"segment":{"index":0,"last":null}}`,
    ],
    [
      "a duplicate index",
      `{"revision":7,"changes":[],"segment":{"index":0,"index":1,"last":true}}`,
    ],
    [
      "a segment that is not an object",
      `{"revision":7,"changes":[],"segment":[0,true]}`,
    ],
  ])("refuses %s", (_name, batch) => {
    expect(ok(one(batch))).toMatchObject({ ok: false });
  });
  test("a segment must be the only batch of a DELTA page", () => {
    const seg = `{"revision":7,"changes":[],"segment":{"index":0,"last":false}}`;
    expect(
      ok(
        `{"phase":"delta","next_cursor":"c","has_more":true,"batches":[${seg},{"revision":8,"changes":[]}]}`,
      ),
    ).toMatchObject({
      ok: false,
      reason: "a segment must be the only batch of a delta page",
    });
    expect(
      ok(
        `{"phase":"snapshot","next_cursor":"c","has_more":true,"batches":[${seg}]}`,
      ),
    ).toMatchObject({
      ok: false,
      reason: "a segment must be the only batch of a delta page",
    });
    // Two whole batches are still an ordinary page with the option.
    expect(
      ok(
        `{"phase":"delta","next_cursor":"c","has_more":true,"batches":[{"revision":7,"changes":[]},{"revision":8,"changes":[]}]}`,
      ).ok,
    ).toBe(true);
  });
});

describe("U2: the adapter and the ladder below limit 1", () => {
  test("the request opts in only where the server is known to segment, and always while a revision is staged", () => {
    expect(
      maxChangesFor({
        configured: 100,
        capable: false,
        stepped: null,
        staged: false,
      }),
    ).toEqual({
      maxChanges: null,
      allowSegment: false,
    });
    expect(
      maxChangesFor({
        configured: null,
        capable: true,
        stepped: null,
        staged: false,
      }),
    ).toEqual({
      maxChanges: null,
      allowSegment: false,
    });
    expect(
      maxChangesFor({
        configured: 100,
        capable: true,
        stepped: null,
        staged: false,
      }),
    ).toEqual({
      maxChanges: 100,
      allowSegment: true,
    });
    expect(
      maxChangesFor({
        configured: 100,
        capable: true,
        stepped: 12,
        staged: false,
      }),
    ).toEqual({
      maxChanges: 12,
      allowSegment: true,
    });
    // A continuation is followed whatever the capability says; with no budget at all the remainder comes as one final segment.
    expect(
      maxChangesFor({
        configured: 100,
        capable: false,
        stepped: null,
        staged: true,
      }),
    ).toEqual({
      maxChanges: 100,
      allowSegment: true,
    });
    expect(
      maxChangesFor({
        configured: null,
        capable: false,
        stepped: null,
        staged: true,
      }),
    ).toEqual({
      maxChanges: null,
      allowSegment: true,
    });
    expect([
      clampChanges(1),
      clampChanges(4),
      clampChanges(99.9),
      clampChanges(5000),
    ]).toEqual([4, 4, 99, 800]);
    expect(SEGMENT_CONTRACT).toEqual({
      parameter: "max_changes",
      minChanges: 4,
      maxChanges: 800,
    });
  });

  test("the continuity table", () => {
    const st: DeltaStage = {
      revision: 7,
      next_index: 2,
      boundary_cursor: "b",
      cursor: "c",
      changes: 8,
      bytes: 100,
      started_at: 0,
    };
    const seg = (index: number, last: boolean, revision = 7) => ({
      revision,
      segment: { index, last },
    });
    expect(continuityOf(null, { revision: 7, segment: null })).toEqual({
      kind: "whole",
    });
    expect(continuityOf(null, seg(0, false))).toEqual({ kind: "start" });
    expect(continuityOf(null, seg(0, true))).toEqual({
      kind: "finish",
      staged: false,
    });
    expect(continuityOf(null, seg(1, false)).kind).toBe("broken");
    expect(continuityOf(st, seg(2, false))).toEqual({ kind: "continue" });
    expect(continuityOf(st, seg(2, true))).toEqual({
      kind: "finish",
      staged: true,
    });
    for (const bad of [
      seg(1, false),
      seg(3, false),
      seg(0, false),
      seg(2, true, 8),
    ])
      expect(continuityOf(st, bad).kind).toBe("broken");
    expect(continuityOf(st, { revision: 7, segment: null }).kind).toBe(
      "broken",
    );
    // A stage belongs to the cursor it stored.
    expect(stageOf({ cursor: "c", delta_stage: st })).toBe(st);
    expect(stageOf({ cursor: "other", delta_stage: st })).toBeNull();
    expect(stageOf({ cursor: "c" })).toBeNull();
  });

  test("a device signal at limit 1 halves max_changes to 4 before ANY floor hit; quota and oversize never step", () => {
    let state: SizingState = {
      limit: 1,
      class: "unknown",
      floor_hits: 0,
      attempt: null,
    };
    const seen: number[] = [];
    let budget = 100;
    for (;;) {
      const out = nextSizing(
        state,
        { kind: "allocation_failed" },
        DATA_CONFIG,
        budget,
      );
      state = out.state;
      if (out.action !== "retry_lower") break;
      budget = state.max_changes as number;
      seen.push(budget);
      expect(state.floor_hits).toBe(0);
    }
    expect(seen).toEqual([50, 25, 12, 6, 4]);
    // At the minimum response, the ordinary floor count begins.
    expect(state.floor_hits).toBe(1);
    // A local abort at the minimum is the local-write class: retried, never a floor hit.
    const at4: SizingState = { ...state, floor_hits: 0, max_changes: 4 };
    expect(
      nextSizing(
        at4,
        { kind: "commit_failed", cause: "abort" },
        DATA_CONFIG,
        4,
      ),
    ).toMatchObject({
      action: "retry_same",
      state: { floor_hits: 0 },
    });
    for (const kind of ["quota", "oversize"] as const)
      expect(
        nextSizing({ ...at4, max_changes: 50 }, { kind }, DATA_CONFIG, 50),
      ).toMatchObject({
        action: "continue",
        state: { max_changes: 50 },
      });
    // Above limit 1 the limit steps first, and without a segmented request nothing changes below it.
    expect(
      nextSizing(
        { ...at4, limit: 4 },
        { kind: "watchdog", elapsedMs: 1 },
        DATA_CONFIG,
        100,
      ).state,
    ).toMatchObject({
      limit: 2,
      max_changes: 4,
    });
    expect(
      nextSizing(
        { ...at4, max_changes: undefined },
        { kind: "watchdog", elapsedMs: 1 },
      ).state.floor_hits,
    ).toBe(1);
  });
});

describe("U3 and U8: a revision staged in segments and activated equals the whole batch", () => {
  const SIZES = [1, 5, 37, 200, 800];
  const BUDGETS = [4, 7, 25, 100, 800];
  test.each(SIZES.flatMap((n) => BUDGETS.map((m) => [n, m] as const)))(
    "%i changes in segments of %i: the same database as the whole batch, with at most one window of staged words in hand",
    async (n, m) => {
      const changes = revisionOf(n * 31 + m, n);
      const whole = await pageWorld();
      seedLocalWork(whole);
      const w = await pageWorld();
      seedLocalWork(w);
      const out = await whole.commit(
        inputOf(whole, {
          revision: 7,
          changes,
          hasMore: false,
          nextCursor: "final",
        }),
      );
      expect(out.kind).toBe("applied");

      const window = 3;
      const kinds = await deliver(w, segmentsOf(7, changes, m), {
        reconcileWindow: window,
      });
      const pieces = Math.max(1, Math.ceil(n / m));
      expect(kinds).toEqual([...Array(pieces - 1).fill("staged"), "committed"]);
      expect(w.snapshot()).toEqual(whole.snapshot());
      expect(w.rows("delta_staging" as never)).toEqual([]);
      expect(w.sync().delta_stage).toBeNull();
      if (pieces > 1)
        expect(
          w.env.idb.reads.maxBatch.get("delta_staging") ?? 0,
        ).toBeLessThanOrEqual(window);
    },
  );

  test("a revision that arrives in ONE segment (index 0, last) is an ordinary page", async () => {
    const changes = revisionOf(5, 6);
    const whole = await pageWorld();
    const w = await pageWorld();
    await whole.commit(
      inputOf(whole, {
        revision: 7,
        changes,
        hasMore: false,
        nextCursor: "final",
      }),
    );
    expect(await deliver(w, segmentsOf(7, changes, 800))).toEqual([
      "committed",
    ]);
    expect(w.snapshot()).toEqual(whole.snapshot());
  });

  test("an empty final segment activates what was staged", async () => {
    const changes = revisionOf(9, 8);
    const whole = await pageWorld();
    const w = await pageWorld();
    await whole.commit(
      inputOf(whole, {
        revision: 7,
        changes,
        hasMore: false,
        nextCursor: "final",
      }),
    );
    const segments = segmentsOf(7, changes, 4);
    const last = segments.at(-1) as SegmentSpec;
    last.segment = { index: segments.length - 1, last: false };
    last.hasMore = true;
    last.nextCursor = "cont-last";
    segments.push({
      revision: 7,
      changes: [],
      segment: { index: segments.length, last: true },
      hasMore: false,
      nextCursor: "final",
    });
    expect(await deliver(w, segments)).toEqual([
      ...Array(segments.length - 1).fill("staged"),
      "committed",
    ]);
    expect(w.snapshot()).toEqual(whole.snapshot());
  });
});

describe("U4: nothing partial is ever live, and a failed activation leaves the stage intact", () => {
  test("staged segments change no cache row, applied revision, last sync, page sequence or composition generation", async () => {
    const w = await pageWorld();
    seedLocalWork(w);
    const before = w.snapshot() as Record<string, object[]>;
    const segments = segmentsOf(7, revisionOf(3, 30), 7);
    await deliver(w, segments.slice(0, -1));
    const after = w.snapshot() as Record<string, object[]>;
    for (const store of [
      "cache",
      "drafts",
      "draft_commands",
      "pending_effects",
      "resource_versions",
    ])
      expect(after[store], store).toEqual(before[store]);
    const sync = w.sync();
    const was = before.sync_state?.[0] as typeof sync;
    expect(sync).toMatchObject({
      applied_revision: was.applied_revision,
      last_synced_at: was.last_synced_at,
      page_seq: was.page_seq,
      cursor: segments.at(-2)?.nextCursor,
    });
    expect(sync.composition_seq ?? 0).toBe(was.composition_seq ?? 0);
    expect(sync.delta_stage).toMatchObject({
      revision: 7,
      next_index: segments.length - 1,
      boundary_cursor: "cursor-0",
    });
    expect(
      (w.rows("delta_staging" as never) as unknown[]).length,
    ).toBeGreaterThan(0);
  });

  test("a fault at EVERY write of the activation leaves cache and staging exactly as they were; the retry activates identically", async () => {
    const changes = revisionOf(11, 12);
    const segments = segmentsOf(7, changes, 5);
    const reference = await pageWorld();
    await deliver(reference, segments);
    const finalState = reference.snapshot();
    // Writes of the activation: 12 staged-or-final cache writes at most, the staging deletions and the singleton; a generous bound.
    let faulted = 0;
    for (let n = 1; n <= 20; n += 1) {
      const w = await pageWorld();
      await deliver(w, segments.slice(0, -1));
      const staged = w.snapshot();
      w.env.idb.inject({
        match: (tx) => tx.label === "data.commitPage",
        mode: { kind: "throw_on_write", n, as: "error" },
        times: 1,
      });
      const failed = await w.commit(inputOf(w, segments.at(-1) as SegmentSpec));
      if (failed.kind === "applied") {
        // Fewer writes than n: the transaction had nothing left to fault and committed; it must be the final state.
        expect(w.snapshot()).toEqual(finalState);
        continue;
      }
      expect(failed.kind, `fault at write ${n}`).toBe("failed");
      faulted += 1;
      expect(w.snapshot(), `fault at write ${n}`).toEqual(staged);
      const again = await w.commit(inputOf(w, segments.at(-1) as SegmentSpec));
      expect(again.kind).toBe("applied");
      expect(w.snapshot()).toEqual(finalState);
    }
    // Not vacuous: the activation's writes were faulted one by one.
    expect(faulted).toBeGreaterThanOrEqual(5);
  });
});

describe("U5: a broken sequence applies nothing and asks for the revision again", () => {
  async function staged(): Promise<{
    w: PageWorld;
    segments: SegmentSpec[];
    before: Record<string, object[]>;
  }> {
    const w = await pageWorld();
    const before = w.snapshot() as Record<string, object[]>;
    const segments = segmentsOf(7, revisionOf(21, 20), 4);
    await deliver(w, segments.slice(0, 2));
    return { w, segments, before };
  }
  const expectRestarted = (
    w: PageWorld,
    before: Record<string, object[]>,
    out: Awaited<ReturnType<PageWorld["commit"]>>,
  ) => {
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "restarted" },
    });
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.sync().delta_stage).toBeNull();
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(w.cache()).toEqual(before.cache);
  };
  test("a skipped segment, a repeated one, another revision and a non-final segment that ends the feed (W27)", async () => {
    for (const bad of [
      (s: SegmentSpec[]) => s[3] as SegmentSpec,
      (s: SegmentSpec[]) => ({ ...(s[0] as SegmentSpec) }),
      (s: SegmentSpec[]) => ({ ...(s[2] as SegmentSpec), revision: 8 }),
      (s: SegmentSpec[]) => ({ ...(s[2] as SegmentSpec), hasMore: false }),
    ]) {
      const { w, segments, before } = await staged();
      expectRestarted(w, before, await stage(w, inputOf(w, bad(segments))));
    }
  });
  test("a final segment out of order, and a whole page while a revision is staged (W1)", async () => {
    for (const bad of [
      (s: SegmentSpec[]) => s.at(-1) as SegmentSpec,
      (s: SegmentSpec[]) => ({
        revision: 8,
        changes: (s[2] as SegmentSpec).changes,
        hasMore: false,
        nextCursor: "x",
      }),
    ]) {
      const { w, segments, before } = await staged();
      expectRestarted(w, before, await w.commit(inputOf(w, bad(segments))));
    }
  });
  test("a later segment with nothing staged changes nothing but is still a refusal", async () => {
    const w = await pageWorld();
    const before = w.snapshot();
    const out = await stage(
      w,
      inputOf(w, {
        revision: 7,
        changes: [],
        segment: { index: 1, last: false },
        hasMore: true,
        nextCursor: "n",
      }),
    );
    expect(out).toMatchObject({
      kind: "applied",
      value: { kind: "restarted" },
    });
    expect(w.snapshot()).toEqual(before);
    const fin = await w.commit(
      inputOf(w, {
        revision: 7,
        changes: [],
        segment: { index: 2, last: true },
        hasMore: false,
        nextCursor: "n",
      }),
    );
    expect(fin).toMatchObject({
      kind: "applied",
      value: { kind: "restarted" },
    });
    expect(w.snapshot()).toEqual(before);
  });
  test("after a restart the revision is delivered again from the beginning and activates once", async () => {
    const { w, segments } = await staged();
    await stage(w, inputOf(w, segments[3] as SegmentSpec));
    const reference = await pageWorld();
    await deliver(reference, segments);
    expect(await deliver(w, segments)).toEqual([
      ...Array(segments.length - 1).fill("staged"),
      "committed",
    ]);
    expect(w.cache()).toEqual(reference.cache());
  });
});

describe("U6: a duplicated or late answer stages nothing twice", () => {
  test("the same segment for a cursor that has moved is dropped by CAS; so is the final one after activation", async () => {
    const w = await pageWorld();
    const segments = segmentsOf(7, revisionOf(31, 12), 4);
    const first = inputOf(w, segments[0] as SegmentSpec);
    await stage(w, first);
    const once = w.snapshot();
    expect(await stage(w, first)).toEqual({
      kind: "dropped",
      reason: "position",
    });
    expect(w.snapshot()).toEqual(once);
    await deliver(w, segments.slice(1));
    const done = w.snapshot();
    const lastAgain = inputOf(w, segments.at(-1) as SegmentSpec, {
      captured: w.capture({
        expectedPosition: segments.at(-2)?.nextCursor ?? null,
      }),
    });
    expect(await w.commit(lastAgain)).toEqual({
      kind: "dropped",
      reason: "position",
    });
    expect(w.snapshot()).toEqual(done);
  });
});

describe("U7: every replacement of the position retires the stage", () => {
  test("W18 (410 resync_required) clears the staged words and the stage with the position", async () => {
    const w = await pageWorld();
    const segments = segmentsOf(7, revisionOf(41, 12), 4);
    await deliver(w, segments.slice(0, 2));
    const out = await w.service.commit(invalidateRecoveryPosition, {
      captured: w.capture(),
      reason: "resync_required",
    });
    expect(out.kind).toBe("applied");
    expect(w.sync()).toMatchObject({
      cursor: null,
      delta_stage: null,
      cache_status: "invalid",
    });
    expect(w.rows("delta_staging" as never)).toEqual([]);
  });
  test("a stage whose cursor was replaced by any other writer is no stage: its continuation applies nothing, and the next page clears it", async () => {
    const w = await pageWorld();
    const segments = segmentsOf(7, revisionOf(43, 12), 4);
    await deliver(w, segments.slice(0, 2));
    // Another writer moved the position (as a snapshot activation or an abandonment does), leaving the old stage behind.
    w.setSync({ cursor: "elsewhere" });
    const before = w.cache();
    const late = await w.commit(inputOf(w, segments.at(-1) as SegmentSpec));
    expect(late).toMatchObject({
      kind: "applied",
      value: { kind: "restarted" },
    });
    expect(w.cache()).toEqual(before);
    expect(w.rows("delta_staging" as never)).toEqual([]);
    expect(w.sync().cursor).toBe("elsewhere");
    // An ordinary page at the new position commits normally.
    const ok = await w.commit(
      inputOf(w, { revision: 9, changes: [], hasMore: false, nextCursor: "n" }),
    );
    expect(ok).toMatchObject({ kind: "applied", value: { kind: "committed" } });
  });
});

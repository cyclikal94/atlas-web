// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  interestingIds,
  type Mention,
  reconcilePage,
} from "../../src/data/model/reconcile";
import type {
  DraftRow,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../src/data/model/types";
import { draftRow, effectRow, uuid, versionRow } from "../support/data/rows";

/**
 * F-C6, F-C7, F-C8 (plan 8.3): what a delta page does to the local-work stores. The cache is not touched here; the plan streams it.
 */
const R = uuid(100);
const S = uuid(200);
const ack = (over: Partial<DraftRow> = {}) =>
  draftRow({
    status: "acknowledged",
    index_targets: [R],
    target_resource_ids: [R],
    ...over,
  });
const mentionMap = (entries: Array<[string, Mention]>) => new Map(entries);
const upserted = (version: number): Mention => ({ removed: false, version });
const removed: Mention = { removed: true, version: null };
const facts = (
  over: Partial<{
    pageSeq: number;
    hasMore: boolean;
    requestSeq: number | null;
  }> = {},
) => ({ pageSeq: 5, hasMore: false, requestSeq: 10, ...over });
const reconcile = (input: {
  effects?: PendingEffectRow[];
  versions?: ResourceVersionRow[];
  drafts?: DraftRow[];
  mentions?: Array<[string, Mention]>;
  facts?: ReturnType<typeof facts>;
}) =>
  reconcilePage({
    effects: input.effects ?? [],
    versions: input.versions ?? [],
    drafts: input.drafts ?? [],
    mentions: mentionMap(input.mentions ?? []),
    facts: input.facts ?? facts(),
  });

describe("which ids matter", () => {
  test("the ids of pending effects and tracked versions, nothing else", () => {
    const ids = interestingIds(
      [effectRow({ resource_id: R })],
      [versionRow({ resource_id: S })],
    );
    expect([...ids].sort()).toEqual([R, S].sort());
  });
});

describe("F-C6: the per-id mention, not a revision comparison (the 40/50/60 case)", () => {
  test("a page that NAMES the id marks every live row sharing it with the page's own page_seq, whatever the batch was labelled", () => {
    const d1 = ack({ local_id: "d1" });
    const d2 = ack({ local_id: "d2" });
    const e1 = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "one" },
    });
    const e2 = effectRow({
      resource_id: R,
      local_id: "d2",
      display: { label: "two" },
    });
    const out = reconcile({
      effects: [e1, e2],
      drafts: [d1, d2],
      mentions: [[R, removed]],
    });
    // Both rows are finished (cleared, mentioned, their drafts need nothing more): they leave, and so do the drafts.
    expect(out.effectDeletes.sort()).toEqual([
      [R, "d1"],
      [R, "d2"],
    ]);
    expect(out.draftDeletes.sort()).toEqual(["d1", "d2"]);
    expect(out.stats.mentioned).toBe(2);
  });

  test("an in-flight draft's row is MARKED mentioned and kept: the receipt will find the mention and write no display", () => {
    const d = draftRow({
      local_id: "d1",
      status: "in_flight",
      index_targets: [R],
    });
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      submitted_at_page_seq: 3,
    });
    const out = reconcile({
      effects: [e],
      drafts: [d],
      mentions: [[R, removed]],
      facts: facts({ pageSeq: 5 }),
    });
    expect(out.effectDeletes).toEqual([]);
    expect(out.effectPuts).toEqual([
      { ...e, last_mentioned_page_seq: 5, display: null },
    ]);
    expect(out.draftPuts).toEqual([]);
    expect(out.draftDeletes).toEqual([]);
  });

  test("an id the page does not name leaves its row as it was", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "x" },
    });
    const out = reconcile({
      effects: [e],
      drafts: [ack({ local_id: "d1" })],
      mentions: [[S, upserted(2)]],
      facts: facts({ hasMore: true }),
    });
    expect(out).toMatchObject({
      effectPuts: [],
      effectDeletes: [],
      draftPuts: [],
      draftDeletes: [],
    });
  });

  test("a Remove is a mention exactly like an Upsert (absence from a page is not)", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "x" },
    });
    for (const m of [removed, upserted(9)]) {
      const out = reconcile({
        effects: [e],
        drafts: [ack({ local_id: "d1" })],
        mentions: [[R, m]],
      });
      expect(out.effectDeletes).toEqual([[R, "d1"]]);
    }
  });
});

describe("F-C7: release (a), live-edge no_publication, release (b)", () => {
  test("release (a): a mention clears held_pending_cache on the owning draft, and the draft leaves with nothing more to show", () => {
    const d = ack({ local_id: "d1", held_pending_cache: true });
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: null,
      no_publication_floor: 3,
    });
    const out = reconcile({
      effects: [e],
      drafts: [d],
      mentions: [[R, upserted(4)]],
    });
    expect(out.stats.heldReleased).toBe(1);
    expect(out.draftDeletes).toEqual(["d1"]);
    expect(out.effectDeletes).toEqual([[R, "d1"]]);
  });

  test("a draft with a flag still set (held, or an unavailable outcome) keeps its draft AND its finished row", () => {
    const d = ack({ local_id: "d1", unavailable_outcome: true });
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: null,
      no_publication_floor: 3,
    });
    const out = reconcile({
      effects: [e],
      drafts: [d],
      mentions: [[R, upserted(4)]],
    });
    expect(out.draftDeletes).toEqual([]);
    expect(out.effectDeletes).toEqual([]);
    expect(out.effectPuts).toHaveLength(1);
  });

  test("live-edge: an eligible page (request_seq > floor, has_more false) resolves an unmentioned open row as no_publication and drops its display", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "shown" },
      no_publication_floor: 7,
    });
    const out = reconcile({
      effects: [e],
      drafts: [ack({ local_id: "d1" })],
      mentions: [],
      facts: facts({ requestSeq: 8, hasMore: false }),
    });
    expect(out.stats.resolvedNoPublication).toBe(1);
    expect(out.effectDeletes).toEqual([[R, "d1"]]);
  });

  test("the comparison is STRICT: a request captured AT the floor (already in flight when the receipt was recorded) proves nothing (MU-16)", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "shown" },
      no_publication_floor: 7,
    });
    for (const requestSeq of [7, 6, 0]) {
      const out = reconcile({
        effects: [e],
        drafts: [ack({ local_id: "d1" })],
        facts: facts({ requestSeq, hasMore: false }),
      });
      expect(out.stats.resolvedNoPublication, `request_seq ${requestSeq}`).toBe(
        0,
      );
      expect(out.effectPuts).toEqual([]);
    }
  });

  test("a page with has_more true, or no captured request, or a row with no receipt yet (no floor), resolves nothing", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "shown" },
      no_publication_floor: 7,
    });
    expect(
      reconcile({
        effects: [e],
        facts: facts({ requestSeq: 99, hasMore: true }),
      }).stats.resolvedNoPublication,
    ).toBe(0);
    expect(
      reconcile({
        effects: [e],
        facts: facts({ requestSeq: null, hasMore: false }),
      }).stats.resolvedNoPublication,
    ).toBe(0);
    const noReceipt = effectRow({
      resource_id: R,
      local_id: "d2",
      no_publication_floor: null,
    });
    expect(
      reconcile({ effects: [noReceipt], facts: facts({ requestSeq: 99 }) })
        .stats.resolvedNoPublication,
    ).toBe(0);
  });

  test("a row already resolved is not resolved again", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      resolved: "no_publication",
      display: null,
      no_publication_floor: 1,
    });
    expect(
      reconcile({ effects: [e], facts: facts({ requestSeq: 99 }) }).stats
        .resolvedNoPublication,
    ).toBe(0);
  });

  test("release (b): the same transaction moves held_pending_cache to unavailable_outcome, retaining the draft until it is dismissed", () => {
    const d = ack({ local_id: "d1", held_pending_cache: true });
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: null,
      no_publication_floor: 7,
    });
    const out = reconcile({
      effects: [e],
      drafts: [d],
      facts: facts({ requestSeq: 8, hasMore: false }),
    });
    expect(out.stats.unavailable).toBe(1);
    expect(out.draftPuts).toEqual([
      { ...d, held_pending_cache: false, unavailable_outcome: true },
    ]);
    expect(out.draftDeletes).toEqual([]);
    expect(out.effectPuts).toEqual([
      { ...e, resolved: "no_publication", display: null },
    ]);
    expect(out.effectDeletes).toEqual([]);
  });

  test("release (a) runs FIRST per id: a row whose id the page names is never also marked no_publication", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "x" },
      no_publication_floor: 1,
    });
    const out = reconcile({
      effects: [e],
      drafts: [ack({ local_id: "d1" })],
      mentions: [[R, upserted(2)]],
      facts: facts({ requestSeq: 99, hasMore: false }),
    });
    expect(out.stats).toMatchObject({ mentioned: 1, resolvedNoPublication: 0 });
  });

  test("the live-edge rule does not look at last_mentioned_page_seq: a snapshot-phase mention does not disable it", () => {
    const e = effectRow({
      resource_id: R,
      local_id: "d1",
      display: null,
      last_mentioned_page_seq: 2,
      no_publication_floor: 3,
    });
    const out = reconcile({
      effects: [e],
      drafts: [ack({ local_id: "d1", held_pending_cache: true })],
      facts: facts({ requestSeq: 4, hasMore: false }),
    });
    expect(out.stats.resolvedNoPublication).toBe(1);
    expect(out.stats.unavailable).toBe(1);
  });

  test("a draft with two rows: any mention clears the flag (documented); the draft waits for the row still showing an overlay", () => {
    const S2 = uuid(300);
    const d = ack({
      local_id: "d1",
      held_pending_cache: true,
      index_targets: [R, S2],
    });
    const e1 = effectRow({
      resource_id: R,
      local_id: "d1",
      display: { label: "a" },
    });
    const e2 = effectRow({
      resource_id: S2,
      local_id: "d1",
      display: { label: "b" },
    });
    const out = reconcile({
      effects: [e1, e2],
      drafts: [d],
      mentions: [[R, upserted(2)]],
      facts: facts({ hasMore: true }),
    });
    expect(out.draftPuts).toEqual([{ ...d, held_pending_cache: false }]);
    expect(out.draftDeletes).toEqual([]); // e2 still shows its overlay
    expect(out.effectDeletes).toEqual([[R, "d1"]]);
  });
});

describe("F-C8: resource_versions", () => {
  const outstandingDraft = draftRow({
    status: "queued",
    index_targets: [R],
    local_id: "q1",
  });

  test("equal: nothing changes while a draft is outstanding; with none, the record is redundant and leaves", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    expect(
      reconcile({
        versions: [v],
        drafts: [outstandingDraft],
        mentions: [[R, upserted(5)]],
      }),
    ).toMatchObject({ versionPuts: [], versionDeletes: [] });
    expect(
      reconcile({ versions: [v], drafts: [], mentions: [[R, upserted(5)]] })
        .versionDeletes,
    ).toEqual([R]);
  });
  test("higher: the record follows the server, and queued drafts keep their bases (they meet a genuine 409 later)", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    const out = reconcile({
      versions: [v],
      drafts: [outstandingDraft],
      mentions: [[R, upserted(9)]],
    });
    expect(out.versionPuts).toEqual([{ ...v, locally_assumed_version: 9 }]);
    expect(out.draftPuts).toEqual([]); // no queued draft is rewritten
  });
  test("lower: never overwritten (and not removed while a draft stands behind it)", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    expect(
      reconcile({
        versions: [v],
        drafts: [outstandingDraft],
        mentions: [[R, upserted(3)]],
      }),
    ).toMatchObject({ versionPuts: [], versionDeletes: [] });
  });
  test("a lower delivery with NO outstanding draft does not remove it either (a delivery must be at least equal)", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    expect(
      reconcile({ versions: [v], drafts: [], mentions: [[R, upserted(3)]] }),
    ).toMatchObject({ versionPuts: [], versionDeletes: [] });
  });
  test("a Remove: the record leaves only when nothing stands behind it", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    expect(
      reconcile({ versions: [v], drafts: [], mentions: [[R, removed]] })
        .versionDeletes,
    ).toEqual([R]);
    expect(
      reconcile({
        versions: [v],
        drafts: [outstandingDraft],
        mentions: [[R, removed]],
      }).versionDeletes,
    ).toEqual([]);
  });
  test("a settled, superseded or rejected draft does not hold a record; a conflicted or blocked one does", () => {
    const v = versionRow({ resource_id: R, locally_assumed_version: 5 });
    for (const status of ["acknowledged", "superseded", "rejected"] as const)
      expect(
        reconcile({
          versions: [v],
          drafts: [draftRow({ status, index_targets: [R] })],
          mentions: [[R, upserted(5)]],
        }).versionDeletes,
        status,
      ).toEqual([R]);
    for (const status of [
      "queued",
      "in_flight",
      "version_conflict",
      "operation_conflict",
      "blocked",
    ] as const)
      expect(
        reconcile({
          versions: [v],
          drafts: [draftRow({ status, index_targets: [R] })],
          mentions: [[R, upserted(5)]],
        }).versionDeletes,
        status,
      ).toEqual([]);
  });
  test("a timer session follows the local-only rule: a page never reconciles it", () => {
    const v = versionRow({
      resource_id: R,
      locally_assumed_version: 5,
      basis: "timer_session",
    });
    expect(
      reconcile({ versions: [v], mentions: [[R, upserted(9)]] }),
    ).toMatchObject({ versionPuts: [], versionDeletes: [] });
  });
  test("a progress-stream record is reconciled like a resource", () => {
    const v = versionRow({
      resource_id: R,
      locally_assumed_version: 5,
      basis: "progress_stream",
    });
    expect(
      reconcile({ versions: [v], mentions: [[R, upserted(9)]] }).versionDeletes,
    ).toEqual([R]);
  });
});

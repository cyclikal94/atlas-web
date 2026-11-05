// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { DraftWithCommand } from "../../src/data/model/types";
import {
  type ChildPage,
  readChildPage,
  readOutstandingCreates,
} from "../../src/data/plans/outstanding-reads";
import type { Loadable } from "../../src/data/store/port";
import { pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { type PageSpec, uuid } from "../support/data/sync-pages";

/**
 * WEB-11a review 17 (R17.1; design assessment DA17-02..DA17-06): the drafts read with a page of fields are its OUTSTANDING drafts, each
 * counted once. The outbox keeps conflicts and rejections until they are dismissed and an acknowledgement until its receipt is reconciled
 * (`decideDiscard`, `admitReceipt`): any number of them may name a field, and none of them may make its cached page unreadable. Only more
 * than 1,000 outstanding drafts, or one without its body, leave the page's drafts unanswered (null). Through the PRODUCTION plan over the
 * double of IndexedDB (and the production page commit for the live cases); expected values are literal ids, never another plan's answer.
 * FIXTURE evidence: the double counts what a read returned (`idb.reads`); it is not a measurement of a real engine.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;
const PERSON = uuid(1);
const ELSEWHERE = uuid(3);
const F1 = uuid(101);
const F2 = uuid(102);
const KINDS = ["create_person", "put_field", "edit", "archive"];
type World = Awaited<ReturnType<typeof pageWorld>>;

const fields = () => [
  cacheRow({ id: PERSON, label: "Mo" }),
  cacheRow({ id: F1, kind: "field", parent_id: PERSON, label: "field 1" }),
  cacheRow({ id: F2, kind: "field", parent_id: PERSON, label: "field 2" }),
];
/** A put_field draft naming `targets` (the first is its primary target). */
const naming = (
  targets: readonly string[],
  over: Parameters<typeof draftRow>[0] = {},
) =>
  draftRow({
    command: {
      command: {
        kind: "put_field",
        id: targets[0] as string,
        parent_id: PERSON,
        label: "changed",
      },
    },
    target_resource_ids: [...targets],
    index_targets: [...targets],
    ...over,
  });
const page = (
  w: World,
  over: Partial<{ after: string | null; kinds: string[] }> = {},
  scoped = true,
): Promise<ChildPage> =>
  w.service.store.run(readChildPage, {
    incarnationId: w.service.incarnationId,
    kind: "field",
    parentKind: "person",
    ...(scoped ? { parentId: PERSON } : {}),
    after: over.after ?? null,
    kinds: over.kinds ?? KINDS,
  });
const ids = (result: ChildPage) => result.page.rows.map((row) => row.base.id);
const local = (result: ChildPage) =>
  result.drafts === null || result.drafts === undefined
    ? result.drafts
    : result.drafts.map((draft) => draft.local_id);
const read = (w: World, store: string) => ({
  max: w.env.idb.reads.maxBatch.get(store) ?? 0,
  rows: w.env.idb.reads.rows.get(store) ?? 0,
});

/**
 * Retained history that changes nothing shown, in turn: each terminal status, an acknowledgement whose effect is released, and an outstanding
 * draft of another kind. A third names both fields (two index entries), a third only the second.
 */
const STATUSES = [
  { status: "rejected" },
  { status: "version_conflict" },
  { status: "operation_conflict" },
  { status: "superseded" },
  { status: "acknowledged" },
  { status: "queued", kind: "create_task" },
] as const;
const history = (count: number, prefix = "H") =>
  Array.from({ length: count }, (_, i) => {
    const shape = STATUSES[i % STATUSES.length] as {
      status: DraftWithCommand["status"];
      kind?: string;
    };
    const targets = i % 3 === 0 ? [F1] : i % 3 === 1 ? [F1, F2] : [F2];
    return naming(targets, {
      local_id: `${prefix}${String(i).padStart(5, "0")}`,
      created_seq: 10_000 + i,
      status: shape.status,
      ...(shape.kind === undefined ? {} : { kind: shape.kind }),
    });
  });

describe("R17.1: retained history never counts against a page's outstanding drafts (DA17-02)", () => {
  for (const count of [0, 999, 1000, 1001, 2001])
    test(`${count} retained entries over the fields: the same rows, cursor and (no) drafts as with none, nothing removed, no body read`, async () => {
      const w = await pageWorld();
      w.put("cache", fields());
      w.put("drafts", history(count));
      w.env.idb.reads.reset();
      const result = await page(w);
      expect(ids(result)).toEqual([F1, F2]);
      expect(result.page.next).toBeNull();
      expect(Object.keys(result.parents)).toEqual([PERSON]);
      expect(result.drafts).toEqual([]);
      // Nothing outstanding: no body is read, and the history is all still there (a read never dismisses it).
      expect(read(w, "draft_commands").rows).toBe(0);
      expect(w.rows("drafts")).toHaveLength(count);
    });

  test("control: one queued edit among 2,001 retained entries is answered, alone, with its body", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      ...history(2001),
      naming([F2], { local_id: "LIVE", created_seq: 5 }),
    ]);
    const result = await page(w);
    expect(local(result)).toEqual(["LIVE"]);
    expect(result.drafts?.[0]?.command).toEqual({
      command: {
        kind: "put_field",
        id: F2,
        parent_id: PERSON,
        label: "changed",
      },
    });
  });

  test("the ledger's pages: retained history over hidden and over visible fields leaves every page answered, and the walk moves on", async () => {
    const w = await pageWorld();
    w.put("cache", [
      cacheRow({ id: ELSEWHERE, label: "Bo" }),
      // 100 fields of an absent person first in id order, then one of a visible person.
      ...Array.from({ length: 100 }, (_, i) =>
        cacheRow({ id: uuid(200 + i), kind: "field", parent_id: PERSON }),
      ),
      cacheRow({
        id: uuid(400),
        kind: "field",
        parent_id: ELSEWHERE,
        label: "visible",
      }),
    ]);
    w.put("drafts", [
      ...Array.from({ length: 1001 }, (_, i) =>
        naming([uuid(200)], { local_id: `A${i}`, status: "rejected" }),
      ),
      ...Array.from({ length: 1001 }, (_, i) =>
        naming([uuid(400)], { local_id: `B${i}`, status: "rejected" }),
      ),
    ]);
    const first = await page(w, {}, false);
    expect(first.page.rows).toEqual([]);
    expect(first.page.next).toBe(uuid(299));
    expect(first.drafts).toEqual([]);
    const second = await page(w, { after: first.page.next }, false);
    expect(ids(second)).toEqual([uuid(400)]);
    expect(second.parents[ELSEWHERE]?.label).toBe("Bo");
    expect(second.page.next).toBeNull();
    expect(second.drafts).toEqual([]);
  });

  test("no kinds asked for: no drafts, and no draft is read", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [naming([F1], { local_id: "LIVE" })]);
    w.env.idb.reads.reset();
    expect((await page(w, { kinds: [] })).drafts).toEqual([]);
    expect(read(w, "drafts").rows).toBe(0);
  });
});

describe("R17.1: live work among retained history, in queue order (DA17-03)", () => {
  test("every live status before, between and after 1,001 retained entries in key order is answered, oldest created first", async () => {
    // Key order (local_id) is the REVERSE of queue order (created_seq) for the live drafts; retained entries come before, between and
    // after them in key order, so the live ones sit in later windows of the index walk.
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("pending_effects", [
      effectRow({ resource_id: F1, local_id: "Z-acknowledged" }),
    ]);
    w.put("drafts", [
      ...Array.from({ length: 400 }, (_, i) =>
        naming([F1], {
          local_id: `A${String(i).padStart(4, "0")}`,
          created_seq: 1000 + i,
          status: "rejected",
        }),
      ),
      naming([F1], { local_id: "W-queued", created_seq: 40 }),
      naming([F1, F2], {
        local_id: "X-in-flight",
        created_seq: 30,
        status: "in_flight",
      }),
      ...Array.from({ length: 300 }, (_, i) =>
        naming([F1], {
          local_id: `XA${String(i).padStart(4, "0")}`,
          created_seq: 2000 + i,
          status: "operation_conflict",
        }),
      ),
      naming([F2], {
        local_id: "Y-blocked",
        created_seq: 20,
        status: "blocked",
        review_block: { kind: "defaults", kinds: ["put_field"] },
      }),
      naming([F1], {
        local_id: "Z-acknowledged",
        created_seq: 10,
        status: "acknowledged",
      }),
      ...Array.from({ length: 301 }, (_, i) =>
        naming([F2], {
          local_id: `ZZ${String(i).padStart(4, "0")}`,
          created_seq: 3000 + i,
          status: "version_conflict",
        }),
      ),
    ]);
    const result = await page(w);
    expect(ids(result)).toEqual([F1, F2]);
    expect(local(result)).toEqual([
      "Z-acknowledged",
      "Y-blocked",
      "X-in-flight",
      "W-queued",
    ]);
  });
});

describe("R17.1: each draft counted once; real overflow stays incomplete (DA17-04)", () => {
  const unique = (count: number) =>
    // 600 name both fields (1,200 index entries), the rest one: `count` drafts, `count + 600` entries.
    Array.from({ length: count }, (_, i) =>
      naming(i < 600 ? [F1, F2] : [F1], {
        local_id: `D${String(i).padStart(5, "0")}`,
        created_seq: i + 1,
      }),
    );

  test("1,000 outstanding drafts over 1,600 entries, with 2,001 retained: all 1,000 answered, each once", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [...unique(1000), ...history(2001)]);
    const result = await page(w);
    expect(result.drafts).toHaveLength(1000);
    expect(new Set(local(result))).toHaveProperty("size", 1000);
    expect(result.drafts?.[0]?.local_id).toBe("D00000");
    expect(result.drafts?.at(-1)?.local_id).toBe("D00999");
  });

  test("1,001 outstanding drafts: the drafts are unanswered (null), never a part of them as all", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [...unique(1001), ...history(50)]);
    const result = await page(w);
    expect(result.drafts).toBeNull();
    // The cached page itself is still read whole: it is its drafts that are not.
    expect(ids(result)).toEqual([F1, F2]);
  });
});

describe("R17.1: an acknowledgement counts only while its first primary target's effect stands (DA17-05)", () => {
  test("the matrix: first effect stands / released / only a later target's / no primary target, as readOutstandingCreates decides", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("pending_effects", [
      effectRow({ resource_id: F1, local_id: "ACK-FIRST" }),
      effectRow({ resource_id: F1, local_id: "ACK-SECOND-ONLY" }),
      effectRow({ resource_id: F1, local_id: "ACK-NO-PRIMARY" }),
    ]);
    const ack = { status: "acknowledged" as const };
    w.put("drafts", [
      naming([F1], { local_id: "ACK-FIRST", created_seq: 1, ...ack }),
      naming([F1], { local_id: "ACK-RELEASED", created_seq: 2, ...ack }),
      naming([ELSEWHERE, F1], {
        local_id: "ACK-SECOND-ONLY",
        created_seq: 3,
        ...ack,
      }),
      naming([F1], {
        local_id: "ACK-NO-PRIMARY",
        created_seq: 4,
        ...ack,
        target_resource_ids: [],
      }),
    ]);
    expect(local(await page(w))).toEqual(["ACK-FIRST"]);
    const creates = await w.service.store.run(readOutstandingCreates, {
      incarnationId: w.service.incarnationId,
      kinds: KINDS,
    });
    expect(creates.drafts.map((draft) => draft.local_id)).toEqual([
      "ACK-FIRST",
    ]);
  });

  async function watched(w: World) {
    const watch = w.service.store.watch(readChildPage, {
      incarnationId: w.service.incarnationId,
      kind: "field",
      parentKind: "person",
      parentId: PERSON,
      after: null,
      kinds: KINDS,
    });
    const stop = watch.subscribe(() => {});
    const settle = async () => {
      for (let i = 0; i < 10; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();
    return { watch, stop, settle };
  }
  const ready = (answer: Loadable<ChildPage>): ChildPage => {
    if (answer.status !== "ready")
      throw new Error(`not ready: ${answer.status}`);
    return answer.value;
  };
  const upsert = (revision: number, label: string): PageSpec => ({
    phase: "delta",
    hasMore: false,
    nextCursor: `cursor-${revision}`,
    batches: [
      {
        revision,
        changes: [
          {
            kind: "upsert",
            resource: {
              id: F1,
              kind: "field",
              parent_id: PERSON,
              label,
              value: null,
              version: 2,
              can_edit: true,
              archived: false,
            },
          },
        ],
      },
    ],
  });

  test("receipt then page, live, beside 1,001 retained entries: the acknowledgement is answered, then the page publishes it and it is gone", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      ...history(1001),
      naming([F1], { local_id: "ACK", created_seq: 1, status: "acknowledged" }),
    ]);
    w.put("pending_effects", [
      effectRow({
        resource_id: F1,
        local_id: "ACK",
        display: { label: "pending label" },
        no_publication_floor: 1,
      }),
    ]);
    const t = await watched(w);
    expect(local(ready(t.watch.get()))).toEqual(["ACK"]);
    await w.commit(w.input(upsert(7, "published")));
    await t.settle();
    const after = ready(t.watch.get());
    expect(after.drafts).toEqual([]);
    expect(after.page.rows.map((row) => row.merged.label)).toEqual([
      "published",
      "field 2",
    ]);
    t.stop();
  });

  test("page while a draft is in flight, live, beside 1,001 retained entries: the field's new cached value and the in-flight draft both answered", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      ...history(1001),
      naming([F1], {
        local_id: "IN-FLIGHT",
        created_seq: 1,
        status: "in_flight",
      }),
    ]);
    const t = await watched(w);
    expect(local(ready(t.watch.get()))).toEqual(["IN-FLIGHT"]);
    await w.commit(w.input(upsert(7, "server value")));
    await t.settle();
    const after = ready(t.watch.get());
    expect(local(after)).toEqual(["IN-FLIGHT"]);
    expect(after.page.rows.map((row) => row.base.label)).toEqual([
      "server value",
      "field 2",
    ]);
    t.stop();
  });
});

describe("R17.1: the walk is bounded however long the history (DA17-06)", () => {
  test("10,001 retained entries and one queued edit on one field: no read returns more than a window, one body is read", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      ...Array.from({ length: 10_001 }, (_, i) =>
        naming([F1], {
          local_id: `R${String(i).padStart(6, "0")}`,
          created_seq: 100 + i,
          status: "rejected",
        }),
      ),
      naming([F1], { local_id: "S-LIVE", created_seq: 50 }),
    ]);
    w.env.idb.reads.reset();
    const result = await page(w);
    expect(local(result)).toEqual(["S-LIVE"]);
    expect(read(w, "drafts").max).toBeLessThanOrEqual(WINDOW);
    expect(read(w, "draft_commands")).toEqual({ max: 1, rows: 1 });
    // Cost evidence: the index of the field is walked once (its 10,002 entries), not once per window.
    expect(read(w, "drafts").rows).toBe(10_002);
  });
});

describe("R17.1: a header without its body is not an answer of everything (design assessment C3)", () => {
  const bodiless = (row: ReturnType<typeof draftRow>) => {
    const { command: _, ...header } = row;
    return header;
  };

  test("an outstanding draft whose body is missing: drafts null; the same draft with its body: answered (control)", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      naming([F1], { local_id: "Q1", created_seq: 1 }),
      bodiless(naming([F2], { local_id: "Q2", created_seq: 2 })),
    ]);
    expect((await page(w)).drafts).toBeNull();
    const control = await pageWorld();
    control.put("cache", fields());
    control.put("drafts", [
      naming([F1], { local_id: "Q1", created_seq: 1 }),
      naming([F2], { local_id: "Q2", created_seq: 2 }),
    ]);
    expect(local(await page(control))).toEqual(["Q1", "Q2"]);
  });

  test("a retained rejection whose body is missing changes nothing shown: drafts answered", async () => {
    const w = await pageWorld();
    w.put("cache", fields());
    w.put("drafts", [
      naming([F1], { local_id: "Q1", created_seq: 1 }),
      bodiless(
        naming([F2], { local_id: "R1", created_seq: 2, status: "rejected" }),
      ),
    ]);
    expect(local(await page(w))).toEqual(["Q1"]);
  });
});

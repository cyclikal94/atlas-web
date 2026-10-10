// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { DraftWithCommand } from "../../src/data/model/types";
import {
  type PendingCreatesPage,
  readOutstanding,
  readPendingCreates,
} from "../../src/data/plans/pending-reads";
import { pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * D-13a-4 (WEB-13a): the two feature reads over the outbox, through the PRODUCTION plans over the double of IndexedDB. What is
 * "bounded" is what the double counts (`idb.reads`): the most rows ONE read call returned (`maxBatch`) and the rows read in all. Each
 * bound is asserted at 501 drafts beside a CONTROL of the same shape at five. FIXTURE evidence: a read-size counter, not a heap figure.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;
type World = Awaited<ReturnType<typeof pageWorld>>;

const create = (n: number, over: Partial<DraftWithCommand> = {}) =>
  draftRow({
    local_id: `c${n}`,
    created_seq: n,
    endpoint: "/calendar-commands",
    command: {
      command: {
        kind: "create_source",
        id: uuid(n),
        label: `Calendar ${n}`,
        timezone: "Europe/London",
      },
    },
    target_resource_ids: [uuid(n)],
    index_targets: [uuid(n)],
    ...over,
  });

const pending = (
  w: World,
  after?: number | null,
): Promise<PendingCreatesPage> =>
  w.service.store.run(readPendingCreates, {
    incarnationId: w.service.incarnationId,
    kind: "create_source",
    ...(after === undefined ? {} : { after }),
  });

const outstanding = (w: World, id: string) =>
  w.service.store.run(readOutstanding, {
    incarnationId: w.service.incarnationId,
    id,
  });

const peak = (w: World, store: string) =>
  w.env.idb.reads.maxBatch.get(store) ?? 0;
const rows = (w: World, store: string) => w.env.idb.reads.rows.get(store) ?? 0;

describe("readPendingCreates", () => {
  test("lists the unsettled creates of the kind whose resource the cache does not hold, oldest first, each with its body", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: uuid(2), kind: "calendar_source" })]);
    w.put("drafts", [
      create(1),
      // Its resource is cached: the list shows it from the cache.
      create(2),
      create(3, { status: "superseded" }),
      create(4, { status: "acknowledged", held_pending_cache: true }),
      // Acknowledged with its overlay shown, waiting for the delta page that publishes it: still listed (saving).
      create(5, { status: "acknowledged" }),
      create(6, { status: "rejected" }),
      create(7, { status: "in_flight" }),
      create(8, { status: "version_conflict" }),
      // Another kind against an uncached id.
      draftRow({
        local_id: "other",
        created_seq: 9,
        endpoint: "/calendar-commands",
        command: { command: { kind: "configure_source", id: uuid(9) } },
        target_resource_ids: [uuid(9)],
        index_targets: [uuid(9)],
      }),
    ]);
    const page = await pending(w);
    expect(page.drafts.map((draft) => draft.local_id)).toEqual([
      "c1",
      "c4",
      "c5",
      "c6",
      "c7",
      "c8",
    ]);
    expect(page.total).toBe(6);
    expect(page.next).toBeNull();
    expect(page.drafts[0]?.command).toEqual(create(1).command);
    expect(page.drafts[0]?.kind).toBe("create_source");
  });

  test("501 pending creates among 300 drafts of another kind: windows of 100, an exact total, a cursor that meets every one once, and one window of bodies", async () => {
    const w = await pageWorld();
    const N = 501;
    const all: DraftWithCommand[] = [];
    for (let i = 1; i <= N + 300; i += 1)
      all.push(
        i % 8 === 0 &&
          all.filter((d) => d.kind !== "create_source").length < 300
          ? draftRow({
              local_id: `x${i}`,
              created_seq: i,
              command: { kind: "edit", n: i },
              target_resource_ids: [uuid(100_000 + i)],
              index_targets: [uuid(100_000 + i)],
            })
          : create(i),
      );
    const creates = all.filter((d) => d.kind === "create_source");
    w.put("drafts", all);
    w.env.idb.reads.reset();
    const first = await pending(w);
    expect(first.drafts.length).toBe(WINDOW);
    expect(first.total).toBe(creates.length);
    expect(peak(w, "drafts")).toBeLessThanOrEqual(WINDOW);
    expect(peak(w, "cache")).toBeLessThanOrEqual(WINDOW);
    expect(peak(w, "draft_commands")).toBeLessThanOrEqual(WINDOW);
    // Only the kept window's bodies are read.
    expect(rows(w, "draft_commands")).toBe(WINDOW);
    expect(first.next).toBe(first.drafts[WINDOW - 1]?.created_seq);

    const seen: string[] = [...first.drafts.map((d) => d.local_id)];
    let after = first.next;
    for (let guard = 0; after !== null && guard < 20; guard += 1) {
      const page = await pending(w, after);
      expect(page.total).toBe(creates.length);
      seen.push(...page.drafts.map((d) => d.local_id));
      after = page.next;
    }
    expect(after).toBeNull();
    expect(seen).toEqual(creates.map((d) => d.local_id));
    expect(new Set(seen).size).toBe(creates.length);
  });

  test("control: five creates are one window with no cursor", async () => {
    const w = await pageWorld();
    w.put(
      "drafts",
      Array.from({ length: 5 }, (_, i) => create(i + 1)),
    );
    const page = await pending(w);
    expect(page.drafts.length).toBe(5);
    expect(page.total).toBe(5);
    expect(page.next).toBeNull();
  });

  test("a window that ends exactly on the last draft says there is no more (the boundary draft is not skipped)", async () => {
    const w = await pageWorld();
    w.put(
      "drafts",
      Array.from({ length: WINDOW + 1 }, (_, i) => create(i + 1)),
    );
    const first = await pending(w);
    expect(first.drafts.length).toBe(WINDOW);
    const second = await pending(w, first.next);
    expect(second.drafts.map((d) => d.local_id)).toEqual([`c${WINDOW + 1}`]);
    expect(second.next).toBeNull();
  });

  test("a read under another incarnation is refused, and an empty database lists nothing", async () => {
    const w = await pageWorld();
    await expect(
      w.service.store.run(readPendingCreates, {
        incarnationId: "another",
        kind: "create_source",
      }),
    ).rejects.toMatchObject({
      cause: "plan_rejected",
      detail: { stage: "guard", reason: "incarnation" },
    });
    expect(await pending(w)).toEqual({ drafts: [], total: 0, next: null });
  });
});

describe("readOutstanding", () => {
  const target = uuid(77);
  const against = (n: number, over: Partial<DraftWithCommand> = {}) =>
    draftRow({
      local_id: `o${n}`,
      created_seq: n,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "configure_source",
          id: target,
          expected_version: n,
          timezone: "UTC",
          enabled: true,
        },
      },
      target_resource_ids: [target],
      index_targets: [target],
      ...over,
    });

  test("counts the unsettled drafts against the resource by status, exactly, and returns the NEWEST with its body", async () => {
    const w = await pageWorld();
    w.put("drafts", [
      against(1, { status: "acknowledged", held_pending_cache: true }),
      against(2, { status: "superseded" }),
      against(3, { status: "version_conflict" }),
      against(4),
      against(5, { status: "acknowledged" }),
      against(6),
      // Another resource.
      draftRow({
        local_id: "elsewhere",
        created_seq: 7,
        target_resource_ids: [uuid(78)],
        index_targets: [uuid(78)],
      }),
    ]);
    const out = await outstanding(w, target);
    expect(out.total).toBe(5);
    expect(out.byStatus).toEqual({
      acknowledged: 2,
      version_conflict: 1,
      queued: 2,
    });
    expect(out.latest?.local_id).toBe("o6");
    expect(out.latest?.command).toEqual(against(6).command);
  });

  test("501 drafts against one resource: a window at a time, exact counts, and ONE body read", async () => {
    const w = await pageWorld();
    w.put(
      "drafts",
      Array.from({ length: 501 }, (_, i) =>
        against(i + 1, i % 2 === 0 ? {} : { status: "in_flight" }),
      ),
    );
    w.env.idb.reads.reset();
    const out = await outstanding(w, target);
    expect(out.total).toBe(501);
    expect(out.byStatus).toEqual({ queued: 251, in_flight: 250 });
    expect(out.latest?.local_id).toBe("o501");
    expect(peak(w, "drafts")).toBeLessThanOrEqual(WINDOW);
    expect(rows(w, "draft_commands")).toBe(1);
  });

  test("control: nothing against the resource", async () => {
    const w = await pageWorld();
    const out = await outstanding(w, target);
    expect(out).toEqual({ total: 0, byStatus: {}, latest: null });
  });
});

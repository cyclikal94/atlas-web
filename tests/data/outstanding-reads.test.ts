// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { DraftRow, DraftWithCommand } from "../../src/data/model/types";
import { readOutstandingCreates } from "../../src/data/plans/outstanding-reads";
import { listReadPlans } from "../../src/data/plans/registry";
import { pageWorld } from "../support/data/page-world";
import { draftRow, effectRow } from "../support/data/rows";

/**
 * `readOutstandingCreates` (WEB-11a §3.1 item 2; the same name, signature and semantics as WEB-10a's plan): the outstanding drafts of the
 * kinds asked for, with their bodies, oldest first, one window at a time. Fixture evidence over the double of IndexedDB.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;
type World = Awaited<ReturnType<typeof pageWorld>>;

const putField = (
  seq: number,
  over: Partial<DraftWithCommand> = {},
): DraftWithCommand =>
  draftRow({
    local_id: `d${seq}`,
    created_seq: seq,
    endpoint: "/task-commands",
    command: { command: { kind: "put_field", id: `f${seq}`, parent_id: "p" } },
    target_resource_ids: [`f${seq}`],
    index_targets: [`f${seq}`],
    ...over,
  });

const seed = (w: World, rows: DraftWithCommand[]) => {
  w.put("drafts", rows);
  w.put(
    "draft_commands",
    rows.map((row) => ({ local_id: row.local_id, command: row.command })),
  );
};

const read = (w: World, kinds: string[], after?: number | null) =>
  w.service.store.run(readOutstandingCreates, {
    incarnationId: w.service.incarnationId,
    kinds,
    ...(after === undefined ? {} : { after }),
  });

const ids = (drafts: readonly DraftRow[]) => drafts.map((d) => d.local_id);

describe("readOutstandingCreates", () => {
  test("is a registered READ plan (not a writer)", () => {
    const entry = listReadPlans().find(
      (plan) => plan.name === "data.readOutstandingCreates",
    );
    expect(entry?.mode).toBe("readonly");
    expect(entry?.scope).toEqual(
      expect.arrayContaining(["drafts", "draft_commands", "pending_effects"]),
    );
  });

  test("lists queued, in-flight and blocked drafts of the kinds asked for, oldest first, with their bodies", async () => {
    const w = await pageWorld();
    seed(w, [
      putField(3, { status: "in_flight" }),
      putField(1),
      putField(2, {
        status: "blocked",
        blocked_reason: "slice_capacity",
      } as never),
      putField(4, { review_block: { kind: "defaults", kinds: ["field"] } }),
      draftRow({
        local_id: "other",
        created_seq: 5,
        command: { commands: [{ kind: "create_person", id: "x" }] },
      }),
    ]);
    const page = await read(w, ["put_field"]);
    expect(ids(page.drafts)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(page.drafts[0]?.command).toEqual({
      command: { kind: "put_field", id: "f1", parent_id: "p" },
    });
    expect(page.next).toBeNull();
    const both = await read(w, ["put_field", "create_person"]);
    expect(ids(both.drafts)).toEqual(["d1", "d2", "d3", "d4", "other"]);
  });

  test("never lists a conflict, a rejection or a superseded draft", async () => {
    const w = await pageWorld();
    seed(w, [
      putField(1, { status: "version_conflict" }),
      putField(2, { status: "operation_conflict" }),
      putField(3, { status: "rejected" }),
      putField(4, { status: "superseded" }),
      putField(5),
    ]);
    expect(ids((await read(w, ["put_field"])).drafts)).toEqual(["d5"]);
  });

  test("an acknowledged draft is listed only while its own effect on its first target stands", async () => {
    const w = await pageWorld();
    seed(w, [
      putField(1, { status: "acknowledged" }),
      putField(2, { status: "acknowledged" }),
      // An effect of ANOTHER draft on the same target is not this draft's.
      putField(3, { status: "acknowledged", target_resource_ids: ["f1"] }),
    ]);
    w.put("pending_effects", [
      effectRow({ resource_id: "f1", local_id: "d1" }),
    ]);
    expect(ids((await read(w, ["put_field"])).drafts)).toEqual(["d1"]);
  });

  test("a window of 100 at a time: `next` leads to the rest, and nothing is listed twice", async () => {
    const w = await pageWorld();
    const rows = Array.from({ length: WINDOW + 30 }, (_, i) =>
      putField(i + 1, i % 3 === 0 ? { status: "in_flight" } : {}),
    );
    seed(w, rows);
    const first = await read(w, ["put_field"]);
    expect(first.drafts).toHaveLength(WINDOW);
    expect(first.next).toBe(WINDOW);
    const second = await read(w, ["put_field"], first.next);
    expect(second.drafts).toHaveLength(30);
    expect(second.next).toBeNull();
    expect(new Set([...ids(first.drafts), ...ids(second.drafts)]).size).toBe(
      WINDOW + 30,
    );
  });

  test("a full window of another kind does not hide the kinds asked for after it", async () => {
    const w = await pageWorld();
    const noise = Array.from({ length: WINDOW + 5 }, (_, i) =>
      draftRow({
        local_id: `n${i}`,
        created_seq: i + 1,
        command: { kind: "edit", id: `x${i}` },
      }),
    );
    seed(w, [...noise, putField(WINDOW + 10)]);
    const page = await read(w, ["put_field"]);
    expect(ids(page.drafts)).toEqual([`d${WINDOW + 10}`]);
  });

  test("no kinds asked for: nothing", async () => {
    const w = await pageWorld();
    seed(w, [putField(1)]);
    expect((await read(w, [])).drafts).toEqual([]);
  });
});

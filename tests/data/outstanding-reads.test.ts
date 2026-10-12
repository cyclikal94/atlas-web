// @vitest-environment node
import { describe, expect, test } from "vitest";
import { commandKindOf } from "../../src/data/model/outbox";
import { mergeResource } from "../../src/data/model/overlay";
import type { CacheRow, DraftWithCommand } from "../../src/data/model/types";
import { createCommandRegistry } from "../../src/data/outbox/registries";
import {
  readCachePosition,
  readOutstanding,
  readOutstandingByKind,
  readResourcesById,
} from "../../src/data/plans/outstanding-reads";
import { readResourcesNow, scanResources } from "../../src/data/ui/scan";
import { pageWorld } from "../support/data/page-world";
import { cacheRow, draftRow, effectRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * WEB-10a §3.1: the generic data-layer additions, through the PRODUCTION plans over the IndexedDB double. A queued draft has no
 * `pending_effects` row (the claim writes them), so the existing list reads show nothing of it: these reads are what a feature layers.
 */
type World = Awaited<ReturnType<typeof pageWorld>>;
const run = <I, O>(
  w: World,
  plan: Parameters<World["service"]["store"]["run"]>[0],
  input: I,
): Promise<O> =>
  w.service.store.run(
    plan as never,
    {
      incarnationId: w.service.incarnationId,
      ...input,
    } as never,
  ) as Promise<O>;

const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

describe("commandKindOf reads a WRAPPED command (task, calendar and reminder inputs)", () => {
  test("the kind of `{command: {kind}}` is the inner kind, not the endpoint", () => {
    expect(
      commandKindOf({ command: { kind: "record" } }, "/task-commands"),
    ).toBe("record");
    expect(commandKindOf({ kind: "x" }, "/commands")).toBe("x");
    expect(
      commandKindOf({ commands: [{ kind: "grant" }] }, "/access-commands"),
    ).toBe("grant");
    expect(commandKindOf({ command: [] as never }, "/task-commands")).toBe(
      "/task-commands",
    );
  });
});

describe("a projection is taken only for the resource it is asked about", () => {
  const create = draftRow({
    local_id: "c",
    command: { command: { kind: "create_task" } },
    target_resource_ids: [A, B],
  });
  const project = (_d: DraftWithCommand, id: string): CacheRow =>
    cacheRow({ id: A, label: `asked ${id}` });

  test("mergeResource ignores a projection with another id (a multi-resource create projects the task, not the occurrence)", () => {
    expect(
      mergeResource(null, [], [create], project, { id: B }).merged,
    ).toBeNull();
    expect(
      mergeResource(null, [], [create], project, { id: A }).merged?.id,
    ).toBe(A);
    // A multi-target create with no named id projects nothing.
    expect(mergeResource(null, [], [create], project).merged).toBeNull();
  });

  test("the registry passes the asked id and refuses a row of another resource", () => {
    const registry = createCommandRegistry();
    registry.register("create_task", {
      describe: () => "New task",
      projectCreate: (_d, id) => cacheRow({ id: id === B ? A : id }),
    });
    expect(registry.projectCreate(create, A)?.id).toBe(A);
    expect(registry.projectCreate(create, B)).toBeNull();
    expect(registry.projectCreate(create)).toBeNull();
  });
});

describe("readOutstanding", () => {
  test("queued, in-flight and blocked drafts naming a resource, with bodies, oldest first; acknowledged only while its effect stands; attention as headers", async () => {
    const w = await pageWorld();
    w.put("drafts", [
      draftRow({
        local_id: uuid(11),
        created_seq: 3,
        status: "queued",
        index_targets: [A],
        command: { command: { kind: "record" } },
      }),
      draftRow({
        local_id: uuid(12),
        created_seq: 1,
        status: "in_flight",
        index_targets: [A, B],
      }),
      draftRow({
        local_id: uuid(13),
        created_seq: 2,
        status: "blocked",
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(14),
        created_seq: 4,
        status: "acknowledged",
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(15),
        created_seq: 5,
        status: "acknowledged",
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(16),
        created_seq: 6,
        status: "version_conflict",
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(17),
        created_seq: 7,
        status: "superseded",
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(18),
        created_seq: 8,
        status: "queued",
        index_targets: [C],
      }),
    ]);
    // Only the first acknowledged draft's effect is still in place.
    w.put("pending_effects", [
      effectRow({ resource_id: A, local_id: uuid(14) }),
    ]);
    const page = await run<
      object,
      Awaited<ReturnType<typeof readOutstanding.decide>>
    >(w, readOutstanding as never, { ids: [A, B] });
    const outstanding = page as unknown as {
      byId: Record<
        string,
        { drafts: DraftWithCommand[]; attention: { local_id: string }[] }
      >;
      next: string | null;
    };
    expect(outstanding.next).toBeNull();
    expect(outstanding.byId[A]?.drafts.map((d) => d.local_id)).toEqual([
      uuid(12),
      uuid(13),
      uuid(11),
      uuid(14),
    ]);
    expect(outstanding.byId[A]?.drafts[2]?.command).toEqual({
      command: { kind: "record" },
    });
    expect(outstanding.byId[A]?.attention.map((d) => d.local_id)).toEqual([
      uuid(16),
    ]);
    expect(outstanding.byId[B]?.drafts.map((d) => d.local_id)).toEqual([
      uuid(12),
    ]);
  });

  test("bodies are read for one window per call: the ids that would go over it are left for the next call", async () => {
    const w = await pageWorld();
    const rows = [];
    for (let i = 0; i < 90; i += 1)
      rows.push(
        draftRow({
          local_id: uuid(100 + i),
          created_seq: 100 + i,
          index_targets: [A],
        }),
      );
    for (let i = 0; i < 20; i += 1)
      rows.push(
        draftRow({
          local_id: uuid(300 + i),
          created_seq: 300 + i,
          index_targets: [B],
        }),
      );
    w.put("drafts", rows);
    const page = (await run(w, readOutstanding as never, { ids: [A, B] })) as {
      byId: Record<string, { drafts: unknown[] }>;
      next: string | null;
    };
    expect(page.byId[A]?.drafts).toHaveLength(90);
    expect(page.byId[B]).toBeUndefined();
    expect(page.next).toBe(B);
  });
});

describe("readOutstandingByKind", () => {
  test("only the asked kinds, outstanding statuses, oldest first, with bodies; attention headers alongside", async () => {
    const w = await pageWorld();
    w.put("drafts", [
      draftRow({
        local_id: uuid(21),
        created_seq: 2,
        status: "queued",
        kind: "create_task",
        target_resource_ids: [A],
      }),
      draftRow({
        local_id: uuid(22),
        created_seq: 1,
        status: "in_flight",
        kind: "record",
        target_resource_ids: [B],
      }),
      draftRow({
        local_id: uuid(23),
        created_seq: 3,
        status: "queued",
        kind: "create_person",
        target_resource_ids: [C],
      }),
      draftRow({
        local_id: uuid(24),
        created_seq: 4,
        status: "acknowledged",
        kind: "record",
        target_resource_ids: [B],
      }),
      draftRow({
        local_id: uuid(25),
        created_seq: 5,
        status: "acknowledged",
        kind: "record",
        target_resource_ids: [C],
      }),
      draftRow({
        local_id: uuid(26),
        created_seq: 6,
        status: "rejected",
        kind: "record",
        target_resource_ids: [C],
      }),
    ]);
    w.put("pending_effects", [
      effectRow({ resource_id: B, local_id: uuid(24) }),
    ]);
    const page = (await run(w, readOutstandingByKind as never, {
      kinds: ["create_task", "record"],
    })) as {
      drafts: DraftWithCommand[];
      attention: { local_id: string }[];
      next: number | null;
    };
    expect(page.drafts.map((d) => d.local_id)).toEqual([
      uuid(22),
      uuid(21),
      uuid(24),
    ]);
    expect(page.drafts.every((d) => d.command !== undefined)).toBe(true);
    expect(page.attention.map((d) => d.local_id)).toEqual([uuid(26)]);
    expect(page.next).toBeNull();
  });
});

describe("readResourcesById and readCachePosition", () => {
  test("cached rows with their overlays applied; null for an id not cached", async () => {
    const w = await pageWorld();
    w.put("cache", [cacheRow({ id: A, label: "Old" })]);
    w.put("pending_effects", [
      effectRow({
        resource_id: A,
        local_id: uuid(31),
        display: { label: "New" },
      }),
    ]);
    const rows = (await run(w, readResourcesById as never, {
      ids: [A, B],
    })) as Record<string, { merged: CacheRow; pending: number } | null>;
    expect(rows[A]?.merged.label).toBe("New");
    expect(rows[A]?.pending).toBe(1);
    expect(rows[B]).toBeNull();
    const position = (await run(w, readCachePosition as never, {})) as {
      pageSeq: number;
    } | null;
    expect(position?.pageSeq).toBe(w.sync().page_seq);
  });
});

describe("scanResources walks a whole kind a window at a time", () => {
  test("every row once, at most one window per read, `complete`", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 250 }, (_, i) =>
        cacheRow({ id: uuid(1000 + i), kind: "occurrence" }),
      ),
    );
    w.put("cache", [cacheRow({ id: uuid(5000), kind: "task" })]);
    const seen: string[] = [];
    const sizes: number[] = [];
    const end = await scanResources(
      { service: () => w.service },
      { kind: "occurrence", window: 100 },
      (rows) => {
        sizes.push(rows.length);
        for (const row of rows) seen.push(row.base.id);
        return undefined;
      },
      new AbortController().signal,
    );
    expect(end).toBe("complete");
    expect(new Set(seen).size).toBe(250);
    expect(seen).toHaveLength(250);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });

  test("an abort, a visit that stops, and a service that changes end the walk with their reason", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 150 }, (_, i) =>
        cacheRow({ id: uuid(2000 + i), kind: "occurrence" }),
      ),
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await scanResources(
        { service: () => w.service },
        { kind: "occurrence" },
        () => undefined,
        aborted.signal,
      ),
    ).toBe("aborted");
    expect(
      await scanResources(
        { service: () => w.service },
        { kind: "occurrence" },
        () => "stop",
        new AbortController().signal,
      ),
    ).toBe("aborted");
    let current: typeof w.service | null = w.service;
    expect(
      await scanResources(
        { service: () => current },
        { kind: "occurrence", window: 100 },
        () => {
          current = null;
          return undefined;
        },
        new AbortController().signal,
      ),
    ).toBe("closed");
    expect(
      await scanResources(
        { service: () => null },
        { kind: "occurrence" },
        () => undefined,
        new AbortController().signal,
      ),
    ).toBe("closed");
    const now = await readResourcesNow({ service: () => w.service }, [
      uuid(2000),
      uuid(9999),
    ]);
    expect([...(now?.keys() ?? [])]).toEqual([uuid(2000)]);
  });
});

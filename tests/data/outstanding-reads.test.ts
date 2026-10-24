// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { commandKindOf } from "../../src/data/model/outbox";
import { mergeResource } from "../../src/data/model/overlay";
import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
} from "../../src/data/model/types";
import { createCommandRegistry } from "../../src/data/outbox/registries";
import {
  readCachePosition,
  readInventory,
  readOutstanding,
  readOutstandingByKind,
  readOutstandingCreates,
  readResourcesById,
} from "../../src/data/plans/outstanding-reads";
import { listReadPlans } from "../../src/data/plans/registry";
import type { Loadable, Watchable } from "../../src/data/store/port";
import { chainWatch } from "../../src/data/ui/outstanding";
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

  // Adapted (WEB-10a revision 1, R4): a call still reads at most one window of bodies, but the resource that would go over it is now
  // answered from its OLDEST entries up to the window and CONTINUED by a cursor (`{id, after}`), instead of being left whole for the next
  // call (which cut a single resource with more than a window of drafts with no continuation at all). The window bound is kept.
  test("bodies are read for one window per call: the id that would go over it is answered from its oldest and continued by the cursor", async () => {
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
      byId: Record<string, { drafts: { local_id: string }[] }>;
      next: { id: string; after: number } | null;
    };
    expect(page.byId[A]?.drafts).toHaveLength(90);
    expect(page.byId[B]?.drafts.map((d) => d.local_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => uuid(300 + i)),
    );
    expect(page.next).toEqual({ id: B, after: 309 });
    const rest = (await run(w, readOutstanding as never, {
      ids: [A, B],
      after: page.next,
    })) as typeof page;
    expect(rest.byId[A]).toBeUndefined();
    expect(rest.byId[B]?.drafts.map((d) => d.local_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => uuid(310 + i)),
    );
    expect(rest.next).toBeNull();
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

/**
 * R4 (review of 13 October 2026, family `task-outstanding-pagination-completeness`): the outstanding reads are resumable and never drop
 * saved work without a continuation. Every page stays bounded (one window of entries and bodies; a bounded number of headers looked at);
 * a reader that follows `next` sees every entry once.
 */
describe("R4: readOutstanding continues a resource with more than a window of entries", () => {
  type Page = {
    byId: Record<
      string,
      { drafts: { local_id: string }[]; attention: { local_id: string }[] }
    >;
    next: { id: string; after: number } | null;
  };
  const records = (n: number, over: (i: number) => object = () => ({})) =>
    Array.from({ length: n }, (_, i) =>
      draftRow({
        local_id: uuid(1000 + i),
        created_seq: i + 1,
        kind: "record",
        index_targets: [A],
        target_resource_ids: [A],
        ...over(i),
      }),
    );
  async function follow(w: World, ids: string[]) {
    const drafts: string[] = [];
    const attention: string[] = [];
    let after: Page["next"] = null;
    let pages = 0;
    do {
      const page = (await run(w, readOutstanding as never, {
        ids,
        ...(after === null ? {} : { after }),
      })) as Page;
      pages += 1;
      for (const entry of Object.values(page.byId)) {
        drafts.push(...entry.drafts.map((d) => d.local_id));
        attention.push(...entry.attention.map((d) => d.local_id));
      }
      after = page.next;
    } while (after !== null && pages < 50);
    return { drafts, attention, pages };
  }

  for (const count of [100, 101])
    test(`${count} outstanding drafts of one resource: every one is answered (${count === 100 ? "one page" : "a continuation"})`, async () => {
      const w = await pageWorld();
      w.put("drafts", records(count));
      const first = (await run(w, readOutstanding as never, {
        ids: [A],
      })) as Page;
      expect(first.byId[A]?.drafts).toHaveLength(100);
      expect(first.next).toEqual(count === 100 ? null : { id: A, after: 100 });
      const all = await follow(w, [A]);
      expect(all.drafts).toEqual(
        Array.from({ length: count }, (_, i) => uuid(1000 + i)),
      );
    });

  test("attention headers beyond the window are continued as well, in queue order with the drafts", async () => {
    const w = await pageWorld();
    w.put(
      "drafts",
      records(150, (i) => ({ status: i % 2 === 0 ? "queued" : "rejected" })),
    );
    const all = await follow(w, [A]);
    expect(all.pages).toBe(2);
    expect(all.drafts).toHaveLength(75);
    expect(all.attention).toHaveLength(75);
    expect(new Set([...all.drafts, ...all.attention]).size).toBe(150);
  });

  test("more ids than one call reads: the rest are continued, none dropped", async () => {
    const w = await pageWorld();
    const ids = Array.from({ length: 120 }, (_, i) => uuid(5000 + i));
    w.put(
      "drafts",
      ids.map((id, i) =>
        draftRow({
          local_id: uuid(7000 + i),
          created_seq: i + 1,
          index_targets: [id],
          target_resource_ids: [id],
        }),
      ),
    );
    const all = await follow(w, ids);
    expect(all.drafts).toHaveLength(120);
    expect(all.pages).toBe(2);
  });
});

describe("R4: readOutstandingByKind continues through rows that do not match", () => {
  type Page = {
    drafts: { local_id: string }[];
    attention: { local_id: string }[];
    next: number | null;
  };
  async function follow(w: World, kinds: string[]) {
    const drafts: string[] = [];
    const attention: string[] = [];
    let after: number | null = null;
    let pages = 0;
    do {
      const page = (await run(w, readOutstandingByKind as never, {
        kinds,
        ...(after === null ? {} : { after }),
      })) as Page;
      pages += 1;
      drafts.push(...page.drafts.map((d) => d.local_id));
      attention.push(...page.attention.map((d) => d.local_id));
      after = page.next;
    } while (after !== null && pages < 50);
    return { drafts, attention, pages };
  }
  const acknowledged = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      draftRow({
        local_id: uuid(1000 + i),
        created_seq: i + 1,
        kind: "record",
        status: "acknowledged",
        index_targets: [A],
        target_resource_ids: [A],
      }),
    );

  for (const settled of [100, 101])
    test(`an acknowledged draft whose effect stands, after ${settled} whose effects are in the cache, is found`, async () => {
      const w = await pageWorld();
      w.put("drafts", acknowledged(settled + 1));
      w.put("pending_effects", [
        effectRow({ resource_id: A, local_id: uuid(1000 + settled) }),
      ]);
      const first = (await run(w, readOutstandingByKind as never, {
        kinds: ["record"],
      })) as Page;
      // Never "nothing, and no continuation" while an outstanding entry is left.
      expect(
        first.drafts.some((d) => d.local_id === uuid(1000 + settled)) ||
          first.next !== null,
      ).toBe(true);
      expect((await follow(w, ["record"])).drafts).toEqual([
        uuid(1000 + settled),
      ]);
    });

  test("one match after more headers of other kinds than a page looks at: an empty page with a continuation, then the match", async () => {
    const w = await pageWorld();
    w.put(
      "drafts",
      Array.from({ length: 1_200 }, (_, i) =>
        draftRow({
          local_id: uuid(10_000 + i),
          created_seq: i + 1,
          kind: "create_list",
        }),
      ),
    );
    w.put("drafts", [
      draftRow({
        local_id: uuid(30_000),
        created_seq: 1_201,
        kind: "record",
        target_resource_ids: [A],
        index_targets: [A],
      }),
    ]);
    const first = (await run(w, readOutstandingByKind as never, {
      kinds: ["record"],
    })) as Page;
    expect(first.drafts).toEqual([]);
    expect(first.next).toBe(1_000);
    const all = await follow(w, ["record"]);
    expect(all.drafts).toEqual([uuid(30_000)]);
    expect(all.pages).toBe(2);
  });

  test("an entry of a status read further than another is answered once, on the page that reaches it", async () => {
    const w = await pageWorld();
    // The queued status is read only to 1,000 by the first page (other kinds); the rejected one, short, is read to its end.
    w.put(
      "drafts",
      Array.from({ length: 1_200 }, (_, i) =>
        draftRow({
          local_id: uuid(10_000 + i),
          created_seq: i + 1,
          kind: "create_list",
        }),
      ),
    );
    w.put("drafts", [
      draftRow({
        local_id: uuid(30_001),
        created_seq: 1_300,
        kind: "record",
        status: "rejected",
        target_resource_ids: [A],
        index_targets: [A],
      }),
      draftRow({
        local_id: uuid(30_002),
        created_seq: 1_301,
        kind: "record",
        target_resource_ids: [A],
        index_targets: [A],
      }),
    ]);
    const first = (await run(w, readOutstandingByKind as never, {
      kinds: ["record"],
    })) as Page;
    expect(first.attention).toEqual([]);
    expect(first.next).toBe(1_000);
    const all = await follow(w, ["record"]);
    expect(all.attention).toEqual([uuid(30_001)]);
    expect(all.drafts).toEqual([uuid(30_002)]);
  });

  test("statuses merge in queue order across pages; attention beyond a window is continued; every entry once", async () => {
    const w = await pageWorld();
    const statuses = ["queued", "in_flight", "blocked", "rejected"] as const;
    w.put(
      "drafts",
      Array.from({ length: 330 }, (_, i) =>
        draftRow({
          local_id: uuid(1000 + i),
          created_seq: i + 1,
          kind: "record",
          status: statuses[i % 4],
          target_resource_ids: [A],
          index_targets: [A],
        }),
      ),
    );
    const all = await follow(w, ["record"]);
    expect(all.pages).toBe(4);
    expect(all.drafts).toEqual(
      Array.from({ length: 330 }, (_, i) => i)
        .filter((i) => i % 4 !== 3)
        .map((i) => uuid(1000 + i)),
    );
    expect(all.attention).toEqual(
      Array.from({ length: 330 }, (_, i) => i)
        .filter((i) => i % 4 === 3)
        .map((i) => uuid(1000 + i)),
    );
  });
});

describe("R4: chainWatch follows a live read's cursors", () => {
  type Pg = { n: number; next: number | null };
  /** A controllable watch per cursor: `set` answers it, `fail` makes it unavailable; listeners hear each change. */
  function pages() {
    const made = new Map<
      number,
      {
        state: Loadable<Pg>;
        listeners: Set<() => void>;
        subscribed: number;
      }
    >();
    const of = (cursor: number) => {
      let w = made.get(cursor);
      if (!w) {
        w = {
          state: { status: "loading" },
          listeners: new Set(),
          subscribed: 0,
        };
        made.set(cursor, w);
      }
      return w;
    };
    return {
      open: (cursor: number | null): Watchable<Pg> => {
        const w = of(cursor ?? 0);
        return {
          get: () => w.state,
          subscribe(listener) {
            w.listeners.add(listener);
            w.subscribed += 1;
            return () => {
              w.listeners.delete(listener);
            };
          },
        };
      },
      set(cursor: number, state: Loadable<Pg>) {
        const w = of(cursor);
        w.state = state;
        for (const l of [...w.listeners]) l();
      },
      live: (cursor: number) => of(cursor).listeners.size,
    };
  }
  const ready = (n: number, next: number | null): Loadable<Pg> => ({
    status: "ready",
    value: { n, next },
  });

  test("ready only when every page to the last is ready; a page that changes its continuation re-chains; the last complete value is kept meanwhile", () => {
    const p = pages();
    const chain = chainWatch<Pg, number>(
      p.open,
      (page) => page.next,
      (c) => String(c),
    );
    const heard: string[] = [];
    const off = chain.subscribe(() => heard.push(chain.get().status));
    expect(chain.get().status).toBe("loading");
    p.set(0, ready(0, 1));
    expect(chain.get().status).toBe("loading");
    expect(p.live(1)).toBe(1);
    p.set(1, ready(1, 2));
    expect(chain.get().status).toBe("loading");
    p.set(2, ready(2, null));
    const complete = chain.get();
    expect(complete).toEqual({
      status: "ready",
      value: [
        { n: 0, next: 1 },
        { n: 1, next: 2 },
        { n: 2, next: null },
      ],
    });
    // Page 1 now ends the chain: page 2 is no longer watched.
    p.set(1, ready(11, null));
    expect(p.live(2)).toBe(0);
    expect(chain.get()).toEqual({
      status: "ready",
      value: [
        { n: 0, next: 1 },
        { n: 11, next: null },
      ],
    });
    // Page 0 is re-evaluated (loading): the last complete value stands until it is ready again.
    p.set(0, { status: "loading" });
    expect(chain.get().status).toBe("ready");
    p.set(0, { status: "unavailable", reason: "closed" });
    expect(chain.get()).toEqual({ status: "unavailable", reason: "closed" });
    off();
    expect(p.live(0)).toBe(0);
    expect(heard.length).toBeGreaterThan(0);
  });

  test("a continuation that does not advance (a cursor already in the chain) is an error, never a loop", () => {
    const p = pages();
    const chain = chainWatch<Pg, number>(
      p.open,
      (page) => page.next,
      (c) => String(c),
    );
    const off = chain.subscribe(() => undefined);
    p.set(0, ready(0, 5));
    p.set(5, ready(5, 5));
    expect(chain.get()).toEqual({ status: "unavailable", reason: "error" });
    off();
  });
});

/**
 * `readOutstandingCreates` (WEB-11a §3.1 item 2; the same name, signature and semantics as WEB-10a's plan): the outstanding drafts of the
 * kinds asked for, with their bodies, oldest first, one window at a time. Fixture evidence over the double of IndexedDB.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;

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

/**
 * `readInventory` (WEB-11a review 7's design assessment, DA7-12): the cache and the outstanding drafts in ONE read transaction, for a screen
 * to confirm an absence the separate reads suggest. Its step is read as `readResourceList` reads pages (bounded, with cursors), its
 * outstanding saves as `readOutstandingCreates` reads windows; one resource can be read by id instead. Fixture evidence over the double.
 */
describe("readInventory", () => {
  const inventory = (w: World, input: Record<string, unknown>) =>
    w.service.store.run(readInventory, {
      incarnationId: w.service.incarnationId,
      kinds: ["put_field"],
      ...input,
    });
  const person = (n: number) =>
    cacheRow({ id: `p${String(n).padStart(4, "0")}`, kind: "person" });

  test("is a registered READ plan over the cache and the drafts", () => {
    const entry = listReadPlans().find(
      (plan) => plan.name === "data.readInventory",
    );
    expect(entry?.mode).toBe("readonly");
    expect(entry?.scope).toEqual(
      expect.arrayContaining([
        "cache",
        "pending_effects",
        "drafts",
        "draft_commands",
      ]),
    );
  });

  test("a step: the pages of the kind from the cursor, each with the cursor it was read after, up to the pages asked; and every window of outstanding drafts", async () => {
    const w = await pageWorld();
    w.put(
      "cache",
      Array.from({ length: 250 }, (_, i) => person(i)),
    );
    seed(
      w,
      Array.from({ length: WINDOW + 3 }, (_, i) => putField(i + 1)),
    );
    const all = await inventory(w, { kind: "person", pages: 20 });
    expect(all.resource).toBeNull();
    expect(all.pages.map((entry) => entry.after)).toEqual([
      null,
      "p0099",
      "p0199",
    ]);
    expect(all.pages.map((entry) => entry.page.rows.length)).toEqual([
      100, 100, 50,
    ]);
    expect(all.pages.at(-1)?.page.next).toBeNull();
    expect(all.outstanding.map((entry) => entry.page.drafts.length)).toEqual([
      WINDOW,
      3,
    ]);
    expect(all.outstanding[1]?.after).toBe(WINDOW);
    // Bounded: no more pages than asked (and never more than 20), from the cursor given.
    const one = await inventory(w, {
      kind: "person",
      pages: 1,
      after: "p0049",
    });
    expect(one.pages.map((entry) => entry.after)).toEqual(["p0049"]);
    expect(one.pages[0]?.page.rows[0]?.base.id).toBe("p0050");
    expect(one.pages[0]?.page.next).toBe("p0149");
    const capped = await inventory(w, { kind: "person", pages: 99 });
    expect(capped.pages.length).toBe(3);
  });

  test("one resource by id: its cached row (null when not cached), no step", async () => {
    const w = await pageWorld();
    w.put("cache", [person(1)]);
    expect((await inventory(w, { id: "p0001" })).resource?.id).toBe("p0001");
    const missing = await inventory(w, { id: "p0002" });
    expect(missing.resource).toBeNull();
    expect(missing.pages).toEqual([]);
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import { digestOf } from "../../src/data/model/canonical";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  decideSupersede,
  draftWriteBytes,
  type EnqueueRequest,
  planEdit,
  planEnqueue,
  snapshotRequest,
  type TargetSpec,
} from "../../src/data/model/outbox";
import { initialSyncState } from "../../src/data/model/sync-state";
import type {
  DraftRow,
  JsonObject,
  ProjectionPatch,
  SyncStateRow,
} from "../../src/data/model/types";
import { w } from "../../src/data/store/port";
import { outboxWorld } from "../support/data/outbox-world";
import { draftRow, headerOf } from "../support/data/rows";

/**
 * R39 (revision 22): WHAT IS ADMITTED IS WHAT IS DIGESTED IS WHAT IS STORED, whatever the caller does with the graph its `build` returned.
 *
 * The plan digested and measured the object `build` returned and handed that same object on, by reference, to a write that is issued a
 * request at a time (the header's `put` before the body's): IndexedDB clones a value when its `put` is CALLED, so an edit made between the
 * two changed the body after the digest and the admission were taken. The reviewer reproduced it through the real Dexie adapter in all
 * three engines (a 4,996-byte reservation, a 900,000-character body, a digest of another command, 904,978 bytes written).
 *
 * The double of the store used to apply every write of a transaction in one synchronous step and so could not show it; it now has a turn
 * between writes (the native adapter awaits each one) and an `afterPut` observer where the native `put` returns. The first group below
 * pins that, so that the double does not conceal the interval again; the others run the pure plans, then the three public write paths,
 * over it. FIXTURE evidence: the real adapter's counterpart is the real-engine spec `fixture.data-write-snapshot.spec.ts`.
 */
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FRESH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LATER = 900_000;
const NOW = "2026-10-06T10:00:00.000Z";

type World = Awaited<ReturnType<typeof outboxWorld>>;
type Path = "enqueue" | "edit" | "supersede";
const PATHS: Path[] = ["enqueue", "edit", "supersede"];

interface Graph {
  kind: string;
  text: string;
  nested: { label: string };
}
const original = (): Graph => ({
  kind: "create",
  text: "small",
  nested: { label: "original" },
});
/** What the caller does to its graph after the plan has read it. */
const laterEdit = (graph: Graph): void => {
  graph.text = "x".repeat(LATER);
  graph.nested.label = "later edit";
};

/** How a builder hands over its graph: the caller's own object, a fresh root over a shared nested value, or a deep copy (the control). */
type Shape = "direct" | "fresh-root" | "deep-copy";
const SHAPES: Shape[] = ["direct", "fresh-root", "deep-copy"];
const commandOf = (graph: Graph, shape: Shape): JsonObject =>
  (shape === "direct"
    ? graph
    : shape === "fresh-root"
      ? { ...graph }
      : structuredClone(graph)) as unknown as JsonObject;
const requestOf = (id: string, graph: Graph, shape: Shape): EnqueueRequest => ({
  localId: id,
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: commandOf(graph, shape) }),
});

/** A world with a small queued draft under OLD (not for enqueue), in conflict when it is to be superseded; input room as given. */
async function started(path: Path, room: number): Promise<World> {
  const world = await outboxWorld();
  if (path !== "enqueue") {
    const small: EnqueueRequest = {
      localId: OLD,
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { kind: "create", text: "prior" } }),
    };
    expect((await world.outbox.enqueue(small)).kind).toBe("queued");
    if (path === "supersede")
      world.put("drafts", [
        { ...world.drafts()[0], status: "version_conflict" },
      ]);
  }
  world.freeBytes = RESERVE / 2 + room;
  world.quota.invalidate();
  return world;
}
const run = (world: World, path: Path, request: EnqueueRequest) =>
  path === "enqueue"
    ? world.outbox.enqueue(request)
    : path === "edit"
      ? world.outbox.editQueued(OLD, request)
      : world.outbox.supersede(OLD, request);
const idOf = (path: Path): string => (path === "edit" ? OLD : FRESH);

/** What the quota guard was asked to hold, in order. */
function recordReservations(world: World): number[] {
  const asked: number[] = [];
  const reserve = world.quota.reserve.bind(world.quota);
  world.quota.reserve = ((...args: Parameters<typeof reserve>) => {
    asked.push(args[1]);
    return reserve(...args);
  }) as typeof world.quota.reserve;
  return asked;
}

/** Runs `edit` where the FIRST put of a `drafts` row returns (the native `put` has cloned the header; the body's put has not been called). */
function afterHeaderPut(
  world: World,
  edit: () => void,
): { observed(): boolean } {
  let observed = false;
  world.env.idb.afterPut = (store) => {
    if (store !== "drafts" || observed) return;
    observed = true;
    queueMicrotask(edit);
  };
  return { observed: () => observed };
}

describe("the double models the interval the native adapter leaves open", () => {
  test("a put clones its row when it is CALLED, and a turn separates one write of a transaction from the next", async () => {
    // A hand-made plan that, unlike the production plans, writes a graph the caller still owns, by reference. The control for every
    // other test of this file: the edit lands between the two writes, so the production plans' protection is not a vacuous one.
    const world = await outboxWorld();
    const header = headerOf(draftRow({ local_id: FRESH }));
    const caller = { kind: "create", text: "small" };
    const order: string[] = [];
    world.env.idb.afterPut = (store) => {
      order.push(`put ${store}`);
      if (store !== "drafts") return;
      // Synchronously, where the native put returns: the header has been cloned, so this does not reach what was stored.
      header.endpoint = "/changed-after-the-put";
      queueMicrotask(() => {
        order.push("the caller's edit");
        caller.text = "later edit";
      });
    };
    await world.service.store.run(
      {
        name: "test.ownedByReference",
        scope: ["drafts", "draft_commands"],
        mode: "readwrite",
        durability: "strict",
        read: async () => null,
        decide: () => ({
          writes: [
            w.put("drafts", header),
            w.put("draft_commands", { local_id: FRESH, command: caller }),
          ],
          result: null,
        }),
      },
      null,
    );
    world.env.idb.afterPut = null;
    expect(order).toEqual([
      "put drafts",
      "the caller's edit",
      "put draft_commands",
    ]);
    expect(world.drafts().find((row) => row.local_id === FRESH)?.endpoint).toBe(
      "/commands",
    );
    expect(world.commandOf(FRESH)).toEqual({
      kind: "create",
      text: "later edit",
    });
  });
});

describe("the pure plans take ONE private copy of what build returns, and share nothing mutable with the caller", () => {
  const sync = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
    ...initialSyncState("inc"),
    phase: "delta",
    cache_status: "valid",
    ...over,
  });
  const primary: TargetSpec = {
    resourceId: TARGET,
    role: "primary",
    basis: "resource",
    versionChecked: true,
    seedIfUntracked: 1,
  };
  const facts = (over: Partial<Parameters<typeof planEnqueue>[1]> = {}) => ({
    sync: sync(),
    cache: new Map(),
    versions: new Map(),
    related: [] as DraftRow[],
    existing: undefined,
    localId: "L1",
    accountId: "acct",
    now: NOW,
    ...over,
  });
  /** The three caller-owned graphs a build returns: the command, the display patch and the defaults context. */
  const caller = () => ({
    command: { kind: "create", text: "small", nested: { label: "original" } },
    patch: { [TARGET]: { label: "shown" } as unknown as ProjectionPatch },
    context: { audience: { list: ["a"] }, note: "ctx" },
  });
  const requestOver = (graphs: ReturnType<typeof caller>): EnqueueRequest => ({
    endpoint: "/commands",
    targets: [primary],
    build: () => ({
      command: graphs.command as unknown as JsonObject,
      displayPatch: graphs.patch,
      defaultsRevision: "r1",
      defaultsContext: graphs.context,
    }),
  });
  const spoil = (graphs: ReturnType<typeof caller>): void => {
    graphs.command.text = "x".repeat(LATER);
    graphs.command.nested.label = "later edit";
    (graphs.patch[TARGET] as unknown as { label: string }).label = "later";
    graphs.context.audience.list.push("later");
    graphs.context.note = "later";
  };

  test("planEnqueue: the command, the display patch and the defaults context are copies, and a later edit reaches none of them", () => {
    const graphs = caller();
    const planned = planEnqueue(requestOver(graphs), facts());
    if (planned.kind !== "queued") throw new Error(planned.kind);
    expect(planned.command).not.toBe(graphs.command);
    expect(planned.command).toEqual(caller().command);
    const digest = planned.draft.command_digest;
    expect(digest).toBe(digestOf(caller().command));
    spoil(graphs);
    expect(planned.command).toEqual(caller().command);
    expect(digestOf(planned.command)).toBe(digest);
    expect(planned.draft.display_patch).toEqual(caller().patch);
    expect(planned.draft.defaults_context).toEqual(caller().context);
    // and the other way: what the plan holds is not what the caller holds.
    expect(planned.draft.display_patch).not.toBe(graphs.patch);
    expect(planned.draft.defaults_context).not.toBe(graphs.context);
  });

  test("planEdit: the same, from the bases the draft already holds", () => {
    const graphs = caller();
    const draft = headerOf(
      draftRow({
        local_id: "L1",
        target_resource_ids: [TARGET],
        index_targets: [TARGET],
        bases: { [TARGET]: 3 },
        expected_version: 3,
      }),
    );
    const planned = planEdit(requestOver(graphs), draft, sync());
    if (planned.kind !== "edited") throw new Error(planned.kind);
    const digest = planned.draft.command_digest;
    spoil(graphs);
    expect(planned.command).toEqual(caller().command);
    expect(digestOf(planned.command)).toBe(digest);
    expect(planned.draft.display_patch).toEqual(caller().patch);
    expect(planned.draft.defaults_context).toEqual(caller().context);
  });

  test("decideSupersede: the replacement is the same construction (its command, patch and context are copies)", () => {
    const graphs = caller();
    const old = headerOf(
      draftRow({
        local_id: "OLD",
        status: "version_conflict",
        target_resource_ids: [TARGET],
        index_targets: [TARGET],
        bases: { [TARGET]: 2 },
        bumped: [TARGET],
        expected_version: 2,
      }),
    );
    const decision = decideSupersede(requestOver(graphs), {
      old,
      existing: undefined,
      existingPaused: [],
      direct: [],
      cascade: [old],
      effects: [],
      others: [],
      cache: new Map(),
      versions: new Map(),
      sync: sync(),
      localId: "NEW",
      accountId: "acct",
      now: NOW,
    });
    if (decision.kind !== "superseded") throw new Error(decision.kind);
    const digest = decision.draft.command_digest;
    spoil(graphs);
    expect(decision.command).toEqual(caller().command);
    expect(digestOf(decision.command)).toBe(digest);
    expect(decision.draft.display_patch).toEqual(caller().patch);
    expect(decision.draft.defaults_context).toEqual(caller().context);
  });

  test("a result whose fields are read through getters is read ONCE each, and an accessor INSIDE the graph is refused unrun", () => {
    let reads = 0;
    const request: EnqueueRequest = {
      endpoint: "/commands",
      targets: [primary],
      build: () =>
        ({
          get command() {
            reads += 1;
            return reads === 1
              ? { kind: "create", text: "first" }
              : { kind: "create", text: "x".repeat(LATER) };
          },
        }) as never,
    };
    const planned = planEnqueue(request, facts());
    if (planned.kind !== "queued") throw new Error(planned.kind);
    expect(reads).toBe(1);
    expect(planned.command).toEqual({ kind: "create", text: "first" });

    let ran = 0;
    const accessor = Object.defineProperty({ kind: "create" }, "text", {
      enumerable: true,
      get() {
        ran += 1;
        return "x";
      },
    });
    const refused = planEnqueue(
      { ...request, build: () => ({ command: accessor }) },
      facts(),
    );
    expect(refused).toEqual({ kind: "invalid", reason: "not_json" });
    expect(ran).toBe(0);
  });

  test("a builder that keeps or alters the `bases` it was given changes nothing the header stores", () => {
    let kept: Record<string, number> | undefined;
    const request: EnqueueRequest = {
      endpoint: "/commands",
      targets: [primary],
      build: (bases) => {
        kept = bases as Record<string, number>;
        kept[TARGET] = 999;
        return { command: { kind: "create" } };
      },
    };
    const planned = planEnqueue(request, facts());
    if (planned.kind !== "queued") throw new Error(planned.kind);
    expect(planned.draft.bases).toEqual({ [TARGET]: 1 });
    expect(planned.draft.expected_version).toBe(1);
    if (kept === undefined) throw new Error("the builder was not called");
    kept[TARGET] = 12345;
    expect(planned.draft.bases).toEqual({ [TARGET]: 1 });
  });

  test("everything a build returns that is not plain JSON data is `not_json`: a Map, a Date, a class instance, a function", () => {
    for (const odd of [
      new Map([["k", 1]]),
      new Date(0),
      new (class Box {
        a = 1;
      })(),
      () => 1,
    ]) {
      const planned = planEnqueue(
        {
          endpoint: "/commands",
          targets: [primary],
          build: () => ({ command: { kind: "create", odd } as never }),
        },
        facts(),
      );
      expect(planned).toEqual({ kind: "invalid", reason: "not_json" });
    }
    // a throwing builder is the caller's defect and is not `not_json`
    expect(
      planEnqueue(
        {
          endpoint: "/commands",
          targets: [primary],
          build: () => {
            throw new Error("boom");
          },
        },
        facts(),
      ),
    ).toEqual({ kind: "invalid", reason: "build_failed" });
  });
});

describe("the request is copied at the public boundary: what is validated is what is stored", () => {
  test("snapshotRequest copies the endpoint, the target id, the targets, the extra dependencies and the identity, and keeps `build`", () => {
    const request: EnqueueRequest = {
      endpoint: "/calendar-sources/{id}/import",
      targetId: "src-1",
      targets: [
        {
          resourceId: TARGET,
          role: "primary",
          basis: "resource",
          versionChecked: true,
          seedIfUntracked: 1,
        },
      ],
      dependsOnExtra: ["dep-1"],
      localId: FRESH,
      build() {
        return { command: { kind: "create", self: this === request } };
      },
    };
    const copy = snapshotRequest(request);
    expect(copy).not.toBe(request);
    expect(copy.targets).not.toBe(request.targets);
    expect(copy.targets[0]).not.toBe(request.targets[0]);
    expect(copy.dependsOnExtra).not.toBe(request.dependsOnExtra);
    expect(copy).toMatchObject({
      endpoint: "/calendar-sources/{id}/import",
      targetId: "src-1",
      localId: FRESH,
      dependsOnExtra: ["dep-1"],
      targets: [{ resourceId: TARGET, seedIfUntracked: 1 }],
    });
    // `build` is the caller's own function, called as a method of the caller's own request
    expect(copy.build({})).toEqual({ command: { kind: "create", self: true } });
    // absent optionals stay absent
    const bare = snapshotRequest({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    expect(Object.keys(bare).sort()).toEqual(["build", "endpoint", "targets"]);
  });

  for (const path of ["enqueue", "edit", "supersede"] as const)
    test(`${path}: a request edited while the quota reservation is awaited stores what was validated`, async () => {
      const world = await started(path, 1024 * 1024);
      const request: EnqueueRequest = {
        localId: idOf(path),
        endpoint: "/commands",
        targets: [
          {
            resourceId: TARGET,
            role: "primary",
            basis: "resource",
            versionChecked: false,
            seedIfUntracked: 1,
          },
        ],
        // an edit may not change what a draft targets: the resource it was built for
        build: () => ({ command: { kind: "create", text: "small" } }),
      };
      if (path !== "enqueue") request.targets = [];
      const reserve = world.quota.reserve.bind(world.quota);
      world.quota.reserve = ((...args: Parameters<typeof reserve>) => {
        // The caller changes its request after it has been handed over and validated, while the reservation is awaited.
        request.endpoint = "/../escape";
        if (request.targets[0]) request.targets[0].resourceId = "another";
        return reserve(...args);
      }) as typeof world.quota.reserve;
      const outcome = await run(world, path, request);
      expect(outcome.kind).not.toBe("refused");
      const stored = world.drafts().find((row) => row.local_id === idOf(path));
      expect(stored?.endpoint).toBe("/commands");
      if (path === "enqueue") {
        expect(stored?.target_resource_ids).toEqual([TARGET]);
        expect(stored?.index_targets).toEqual([TARGET]);
      }
    });
});

describe("R39: the three public write paths, over a store that leaves the interval open", () => {
  for (const path of PATHS)
    for (const shape of SHAPES) {
      test(`${path}, build returns ${shape === "direct" ? "the caller's own object" : shape === "fresh-root" ? "a fresh root over a nested value the caller still holds" : "a deep copy (the control)"}, edited after the header's put: the body is the one that was digested and admitted`, async () => {
        // Room for 100,000 bytes of input only: the later edit (900,000 characters) is far beyond what was admitted.
        const world = await started(path, 100_000);
        const asked = recordReservations(world);
        const graph = original();
        const probe = afterHeaderPut(world, () => laterEdit(graph));
        const outcome = await run(
          world,
          path,
          requestOf(idOf(path), graph, shape),
        );
        world.env.idb.afterPut = null;
        // The schedule happened: the caller's graph IS the later edit, and the plan had already read it.
        expect(probe.observed()).toBe(true);
        expect(graph.text.length).toBe(LATER);
        expect(outcome.kind).not.toBe("refused");

        const header = world
          .drafts()
          .find((row) => row.local_id === idOf(path));
        const body = world.commandOf(idOf(path)) as JsonObject | undefined;
        if (header === undefined || body === undefined)
          throw new Error("not stored");
        // What is stored is what was built: the small command, not the later edit...
        expect(body).toEqual(original());
        // ...which is what the digest says,
        expect(header.command_digest).toBe(digestOf(body));
        // ...and what the quota admitted covers it.
        const written = draftWriteBytes({
          draft: header,
          command: body,
          versionPuts: world.versions(),
        });
        expect(written).not.toBeNull();
        expect(written as number).toBeLessThanOrEqual(Math.max(...asked));
        world.assertNoOrphanBodies();
      });
    }

  for (const path of PATHS)
    test(`${path}: an ordinary save with nobody editing is stored as built, with its digest`, async () => {
      const world = await started(path, 1024 * 1024);
      const graph = original();
      const outcome = await run(
        world,
        path,
        requestOf(idOf(path), graph, "direct"),
      );
      expect(outcome.kind).not.toBe("refused");
      const header = world.drafts().find((row) => row.local_id === idOf(path));
      expect(world.commandOf(idOf(path))).toEqual(original());
      expect(header?.command_digest).toBe(digestOf(original()));
    });

  for (const path of PATHS)
    test(`${path}: growth that lands BEFORE the plan reads the graph is the save, and is admitted at its real size (room for it)`, async () => {
      const world = await started(path, 2 * 1024 * 1024);
      const asked = recordReservations(world);
      const graph = original();
      // The estimate has read the small graph; the caller grows it while the reservation is awaited; the plan reads the big one.
      const reserve = world.quota.reserve.bind(world.quota);
      let calls = 0;
      world.quota.reserve = ((...args: Parameters<typeof reserve>) => {
        calls += 1;
        if (calls === 1) laterEdit(graph);
        return reserve(...args);
      }) as typeof world.quota.reserve;
      const outcome = await run(
        world,
        path,
        requestOf(idOf(path), graph, "direct"),
      );
      expect(outcome.kind).not.toBe("refused");
      const header = world.drafts().find((row) => row.local_id === idOf(path));
      const body = world.commandOf(idOf(path)) as { text: string };
      expect(body.text.length).toBe(LATER);
      expect(header?.command_digest).toBe(digestOf(body));
      // it was admitted a second time at its real size, and the write is within that
      expect(asked.length).toBeGreaterThanOrEqual(2);
      const written = draftWriteBytes({
        draft: header as DraftRow,
        command: body as unknown as JsonObject,
        versionPuts: world.versions(),
      });
      expect(written as number).toBeLessThanOrEqual(Math.max(...asked));
    });

  for (const path of PATHS)
    test(`${path}: growth that lands before the plan reads the graph, with room for 100,000 bytes only, is refused as quota and what was stored is untouched`, async () => {
      const world = await started(path, 100_000);
      const graph = original();
      const reserve = world.quota.reserve.bind(world.quota);
      let calls = 0;
      world.quota.reserve = ((...args: Parameters<typeof reserve>) => {
        calls += 1;
        if (calls === 1) laterEdit(graph);
        return reserve(...args);
      }) as typeof world.quota.reserve;
      const before = JSON.stringify(world.snapshot());
      const outcome = await run(
        world,
        path,
        requestOf(idOf(path), graph, "direct"),
      );
      expect(outcome).toEqual({ kind: "refused", reason: "quota" });
      expect(JSON.stringify(world.snapshot())).toBe(before);
    });
});

describe("a retry of a supersession is recognised only by plain JSON data", () => {
  // `canonicalJson` turns a `Date`, a `Map` or a class instance into `{}`, so a command that is one of them has the digest of the empty
  // object. The snapshot refuses them (they are not plain data), so a retry that carries one is never mistaken for a stored `{}` command.
  const retried = async (second: unknown) => {
    const world = await started("supersede", 1024 * 1024);
    const first = await world.outbox.supersede(OLD, {
      localId: FRESH,
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: {} }),
    });
    expect(first.kind).toBe("superseded");
    const before = JSON.stringify(world.snapshot());
    const outcome = await world.outbox.supersede(OLD, {
      localId: FRESH,
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: second as JsonObject }),
    });
    return { outcome, unchanged: JSON.stringify(world.snapshot()) === before };
  };

  test("control: the same command under the same id is the previous save, and writes nothing", async () => {
    const { outcome, unchanged } = await retried({});
    expect(outcome.kind).toBe("superseded");
    expect(unchanged).toBe(true);
  });

  for (const [name, odd] of [
    ["a Date", () => new Date(0)],
    ["a Map", () => new Map([["k", 1]])],
    [
      "a class instance",
      () =>
        new (class Box {
          a = 1;
        })(),
    ],
  ] as const)
    test(`${name} is not the stored empty command, however it canonicalises`, async () => {
      const { outcome, unchanged } = await retried(odd());
      expect(outcome).toEqual({ kind: "refused", reason: "not_found" });
      expect(unchanged).toBe(true);
    });
});

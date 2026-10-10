// @vitest-environment node
import { describe, expect, test } from "vitest";
import { digestOf } from "../../src/data/model/canonical";
import {
  decideDiscard,
  decideSupersede,
  type EnqueueRequest,
  OutboxRequestError,
  planEdit,
  planEnqueue,
  recomputeVersions,
  resolveEndpoint,
  type TargetSpec,
  validateRequest,
  wireBody,
} from "../../src/data/model/outbox";
import { initialSyncState } from "../../src/data/model/sync-state";
import type {
  DraftRow,
  ResourceVersionRow,
  SyncStateRow,
} from "../../src/data/model/types";
import {
  cacheRow,
  draftRow,
  effectRow,
  versionRow,
} from "../support/data/rows";

/**
 * The pure rules of the outbox (plan 5.5.2, 5.5.5; WEB-04 D:2867-3350): enqueue, the version base, the cascade and its recompute,
 * supersession. Every assertion here is about a decision, with no database and no clock.
 */
const sync = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
  ...initialSyncState("inc"),
  phase: "delta",
  cache_status: "valid",
  ...over,
});
const NOW = "2026-10-01T10:00:00.000Z";

const primary = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: true,
  ...over,
});
const side = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "side_effect",
  basis: "progress_stream",
  versionChecked: true,
  ...over,
});
const request = (
  targets: TargetSpec[],
  over: Partial<EnqueueRequest> = {},
): EnqueueRequest => ({
  endpoint: "/commands",
  targets,
  build: (bases) => ({ command: { kind: "edit", bases: { ...bases } } }),
  ...over,
});
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

describe("enqueue: the base of each target (plan 5.5.2.2)", () => {
  test("the tracked record wins over the cache, and the cache over the seed", () => {
    const tracked = planEnqueue(
      request([primary("r")]),
      facts({
        versions: new Map([
          ["r", versionRow({ resource_id: "r", locally_assumed_version: 7 })],
        ]),
        cache: new Map([["r", cacheRow({ id: "r", version: 5 })]]),
      }),
    );
    expect(tracked).toMatchObject({
      kind: "queued",
      draft: { expected_version: 7 },
    });
    const cached = planEnqueue(
      request([primary("r", { seedIfUntracked: 1 })]),
      facts({ cache: new Map([["r", cacheRow({ id: "r", version: 5 })]]) }),
    );
    expect(cached).toMatchObject({
      kind: "queued",
      draft: { expected_version: 5 },
    });
    const seeded = planEnqueue(
      request([primary("r", { seedIfUntracked: 1 })]),
      facts(),
    );
    expect(seeded).toMatchObject({
      kind: "queued",
      draft: { expected_version: 1 },
    });
  });

  test("a version-checked primary with no base at all is refused: there is nothing honest to put in expected_version", () => {
    expect(planEnqueue(request([primary("r")]), facts())).toEqual({
      kind: "refused",
      reason: "no_base",
    });
  });

  test("the record becomes base + 1, the draft carries the base, and the command is built from the bases", () => {
    const out = planEnqueue(
      request([primary("r")]),
      facts({ cache: new Map([["r", cacheRow({ id: "r", version: 4 })]]) }),
    );
    if (out.kind !== "queued") throw new Error(out.kind);
    expect(out.versionPuts).toEqual([
      { resource_id: "r", locally_assumed_version: 5, basis: "resource" },
    ]);
    expect(out.draft).toMatchObject({
      status: "queued",
      expected_version: 4,
      bases: { r: 4 },
      bumped: ["r"],
      held_pending_cache: false,
      unavailable_outcome: false,
      attempts: 0,
      created_seq: 1,
    });
    expect(out.command).toEqual({ kind: "edit", bases: { r: 4 } });
    expect(out.draft.kind).toBe("edit");
    expect(out.draft.command_digest).toBe(digestOf(out.command));
    expect(out.sync.draft_seq).toBe(1);
  });

  test("a side effect records the base it assumed and raises its own record; it is indexed exactly as a primary is", () => {
    const out = planEnqueue(
      request([primary("task", { versionChecked: true }), side("stream")]),
      facts({
        cache: new Map([
          ["task", cacheRow({ id: "task", version: 2 })],
          ["stream", cacheRow({ id: "stream", version: 9, kind: "progress" })],
        ]),
      }),
    );
    if (out.kind !== "queued") throw new Error(out.kind);
    expect(out.draft.side_effect_bases).toEqual({ stream: 9 });
    expect(out.draft.target_resource_ids).toEqual(["task"]);
    expect(out.draft.index_targets).toEqual(["task", "stream"]);
    expect(
      out.versionPuts.map((r) => [
        r.resource_id,
        r.locally_assumed_version,
        r.basis,
      ]),
    ).toEqual([
      ["task", 3, "resource"],
      ["stream", 10, "progress_stream"],
    ]);
  });

  test("a resource this client creates is seeded, not raised; a later edit of it is based on the seed", () => {
    const create = planEnqueue(
      request([primary("new", { versionChecked: false, seedIfUntracked: 1 })]),
      facts(),
    );
    if (create.kind !== "queued") throw new Error(create.kind);
    expect(create.draft.expected_version).toBeUndefined();
    expect(create.draft.bumped).toEqual([]);
    expect(create.versionPuts).toEqual([
      { resource_id: "new", locally_assumed_version: 1, basis: "resource" },
    ]);
    const edit = planEnqueue(
      request([primary("new")]),
      facts({
        sync: create.sync,
        related: [create.draft],
        versions: new Map([
          ["new", create.versionPuts[0] as ResourceVersionRow],
        ]),
        localId: "L2",
      }),
    );
    if (edit.kind !== "queued") throw new Error(edit.kind);
    expect(edit.draft.expected_version).toBe(1);
    expect(edit.draft.depends_on).toEqual(["L1"]);
    expect(edit.versionPuts[0]?.locally_assumed_version).toBe(2);
    expect(edit.draft.created_seq).toBe(2);
  });
});

describe("enqueue: order, the fence, and a save made twice", () => {
  test("depends_on is the latest UNSETTLED draft against each target, side effects included, plus the caller's extras", () => {
    const a = draftRow({
      local_id: "a",
      created_seq: 1,
      index_targets: ["r"],
      status: "acknowledged",
    });
    const b = draftRow({ local_id: "b", created_seq: 2, index_targets: ["r"] });
    const c = draftRow({
      local_id: "c",
      created_seq: 3,
      index_targets: ["r", "s"],
      status: "rejected",
    });
    const d = draftRow({ local_id: "d", created_seq: 4, index_targets: ["s"] });
    const out = planEnqueue(
      request(
        [
          primary("r", { seedIfUntracked: 1 }),
          side("s", { seedIfUntracked: 1 }),
        ],
        {
          dependsOnExtra: ["x"],
        },
      ),
      facts({ related: [a, b, c, d] }),
    );
    if (out.kind !== "queued") throw new Error(out.kind);
    // r: b is the latest unsettled (a is settled, c is rejected); s: d. Terminal drafts are never waited on.
    expect(out.draft.depends_on).toEqual(["b", "d", "x"]);
  });

  test("the fence refuses a new draft (and says closing when it is), and changes nothing", () => {
    const fenced = sync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: ["op"],
        consent_digest: "d",
        closing: false,
      },
    });
    expect(planEnqueue(request([]), facts({ sync: fenced }))).toEqual({
      kind: "refused",
      reason: "fenced",
    });
    const closing = sync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: [],
        consent_digest: "",
        closing: true,
      },
    });
    expect(planEnqueue(request([]), facts({ sync: closing }))).toEqual({
      kind: "refused",
      reason: "closing",
    });
  });

  test("a save that already happened under the same local id is recognised and makes no second increment", () => {
    const first = planEnqueue(
      request([primary("r", { seedIfUntracked: 1 })]),
      facts(),
    );
    if (first.kind !== "queued") throw new Error(first.kind);
    const again = planEnqueue(
      request([primary("r", { seedIfUntracked: 1 })]),
      facts({ existing: first.draft }),
    );
    expect(again).toEqual({ kind: "duplicate", draft: first.draft });
  });

  test("a builder that throws, and a command JSON cannot carry, are refused as invalid and write nothing", () => {
    expect(
      planEnqueue(
        request([], {
          build: () => {
            throw new Error("boom");
          },
        }),
        facts(),
      ),
    ).toEqual({ kind: "invalid", reason: "build_failed" });
    expect(
      planEnqueue(
        request([], { build: () => ({ command: { n: Number.NaN } }) }),
        facts(),
      ),
    ).toEqual({ kind: "invalid", reason: "not_json" });
  });
});

describe("validateRequest", () => {
  const ok = request([primary("r")]);
  test.each([
    [
      "an endpoint that is not a path",
      { ...ok, endpoint: "https://evil/x" },
      "endpoint",
    ],
    [
      "an endpoint with a parent segment",
      { ...ok, endpoint: "/a/../b" },
      "endpoint",
    ],
    ["an endpoint with a query", { ...ok, endpoint: "/a?x=1" }, "endpoint"],
    [
      "a template with no target id",
      { ...ok, endpoint: "/calendar-sources/{id}/import" },
      "target_id",
    ],
    [
      "a template that is not {id}",
      { ...ok, endpoint: "/a/{other}/b", targetId: "x" },
      "endpoint",
    ],
    [
      "the same resource twice",
      request([primary("r"), side("r")]),
      "duplicate",
    ],
    [
      "two version-checked primaries",
      request([primary("a"), primary("b")]),
      "two_versioned_primaries",
    ],
    [
      "an unversioned side effect",
      request([side("s", { versionChecked: false })]),
      "side_effect_unversioned",
    ],
  ])("%s", (_name, bad, reason) => {
    expect(() => validateRequest(bad as EnqueueRequest)).toThrow(
      OutboxRequestError,
    );
    try {
      validateRequest(bad as EnqueueRequest);
    } catch (error) {
      expect((error as OutboxRequestError).reason).toBe(reason);
    }
  });

  test("accepted: a plain path and a templated one with a target id", () => {
    expect(() => validateRequest(ok)).not.toThrow();
    expect(() =>
      validateRequest({
        ...ok,
        endpoint: "/calendar-sources/{id}/import",
        targetId: "cal 1",
      }),
    ).not.toThrow();
    expect(resolveEndpoint("/calendar-sources/{id}/import", "cal 1")).toBe(
      "/calendar-sources/cal%201/import",
    );
    expect(resolveEndpoint("/calendar-sources/{id}/import", null)).toBeNull();
    expect(resolveEndpoint("/commands", null)).toBe("/commands");
  });

  test("the wire body is the canonical JSON of the stored command: identical on every attempt", () => {
    const d = draftRow({ command: { b: 1, a: { d: 2, c: 3 } } });
    expect(wireBody(d)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(wireBody(d)).toBe(wireBody({ ...d }));
  });
});

describe("F-O3: an in-place edit is for a queued command only", () => {
  const queued = draftRow({
    local_id: "q",
    endpoint: "/commands",
    target_resource_ids: ["r"],
    index_targets: ["r"],
    bases: { r: 3 },
    bumped: ["r"],
    expected_version: 3,
  });
  const req = request([primary("r")], {
    build: (bases) => ({ command: { kind: "edit", v: bases.r as number } }),
  });
  test("it rebuilds from the draft's own bases and recomputes the digest", () => {
    const out = planEdit(req, queued, sync());
    if (out.kind !== "edited") throw new Error(out.kind);
    expect(out.command).toEqual({ kind: "edit", v: 3 });
    expect(out.draft.command_digest).toBe(digestOf({ kind: "edit", v: 3 }));
    expect(out.draft.created_seq).toBe(queued.created_seq);
  });
  test.each([
    "in_flight",
    "acknowledged",
    "version_conflict",
    "operation_conflict",
    "rejected",
    "blocked",
  ] as const)(
    "a %s draft is refused: its body is frozen once transmitted, and a change is a new draft",
    (status) => {
      expect(planEdit(req, { ...queued, status }, sync())).toEqual({
        kind: "refused",
        reason: "not_queued",
      });
    },
  );
  test("a missing draft, a fence, and a change of target are refused", () => {
    expect(planEdit(req, undefined, sync())).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(
      planEdit(
        req,
        queued,
        sync({
          draft_fence: {
            token: "t",
            started_at: 1,
            operation_ids: ["o"],
            consent_digest: "d",
            closing: false,
          },
        }),
      ),
    ).toEqual({ kind: "refused", reason: "fenced" });
    expect(planEdit(request([primary("other")]), queued, sync())).toEqual({
      kind: "refused",
      reason: "retargeted",
    });
    expect(
      planEdit({ ...req, endpoint: "/task-commands" }, queued, sync()),
    ).toEqual({
      kind: "refused",
      reason: "retargeted",
    });
  });
});

describe("F-O8: the version base after a cascade (WEB-04 D:2867-3085)", () => {
  const ver = (
    id: string,
    v: number,
    basis: ResourceVersionRow["basis"] = "resource",
  ) => versionRow({ resource_id: id, locally_assumed_version: v, basis });
  const chain = (id: string, bases: number[]): DraftRow[] =>
    bases.map((base, i) =>
      draftRow({
        local_id: `${id}${i}`,
        created_seq: i + 1,
        index_targets: [id],
        target_resource_ids: [id],
        bases: { [id]: base },
        bumped: [id],
        expected_version: base,
        depends_on: i === 0 ? [] : [`${id}${i - 1}`],
      }),
    );

  test("the review's counterexample: queue A (base 1), then B (base 2) on it; discarding never-sent A resets the record to 1, never 2", () => {
    const [a, b] = chain("r", [1, 2]) as [DraftRow, DraftRow];
    const out = recomputeVersions({
      members: [a, b],
      others: [],
      cache: new Map([["r", cacheRow({ id: "r", version: 1 })]]),
      versions: new Map([["r", ver("r", 3)]]),
    });
    expect(out.puts).toEqual([ver("r", 1)]);
  });

  test("a delivery that raised the authoritative version past the local chain wins (cache 10, bases 1): the record is 10, never 9", () => {
    const [a] = chain("r", [1]) as [DraftRow];
    const out = recomputeVersions({
      members: [a],
      others: [],
      cache: new Map([["r", cacheRow({ id: "r", version: 10 })]]),
      versions: new Map([["r", ver("r", 10)]]),
    });
    expect(out.puts).toEqual([ver("r", 10)]);
  });

  test("a three-draft chain on one id undoes all three increments at once (min of the bases)", () => {
    const members = chain("r", [4, 5, 6]);
    const out = recomputeVersions({
      members,
      others: [],
      cache: new Map([["r", cacheRow({ id: "r", version: 4 })]]),
      versions: new Map([["r", ver("r", 7)]]),
    });
    expect(out.puts).toEqual([ver("r", 4)]);
  });

  test("a draft that STAYS in the queue still stands on its own base + 1: the record never falls below it", () => {
    const [kept] = chain("r", [3]) as [DraftRow];
    const gone = draftRow({
      local_id: "g",
      created_seq: 9,
      index_targets: ["r"],
      bases: { r: 1 },
      bumped: ["r"],
    });
    const out = recomputeVersions({
      members: [gone],
      others: [kept],
      cache: new Map([["r", cacheRow({ id: "r", version: 1 })]]),
      versions: new Map([["r", ver("r", 4)]]),
    });
    expect(out.puts).toEqual([ver("r", 4)]);
  });

  test("a record for an id with no cached row that nothing outstanding targets is removed (a discarded create)", () => {
    const create = draftRow({
      local_id: "c",
      index_targets: ["new"],
      target_resource_ids: ["new"],
      bases: { new: 1 },
      bumped: [],
    });
    const out = recomputeVersions({
      members: [create],
      others: [],
      cache: new Map(),
      versions: new Map([["new", ver("new", 1)]]),
    });
    expect(out).toEqual({ puts: [], deletes: ["new"] });
  });

  test("a side effect is recomputed exactly as a primary is, with its own basis kept", () => {
    const m = draftRow({
      local_id: "m",
      index_targets: ["task", "s"],
      target_resource_ids: ["task"],
      side_effect_bases: { s: 7 },
      bases: { task: 2, s: 7 },
      bumped: ["task", "s"],
    });
    const out = recomputeVersions({
      members: [m],
      others: [],
      cache: new Map([
        ["task", cacheRow({ id: "task", version: 2 })],
        ["s", cacheRow({ id: "s", version: 7, kind: "progress" })],
      ]),
      versions: new Map([
        ["task", ver("task", 3)],
        ["s", ver("s", 8, "progress_stream")],
      ]),
    });
    expect(out.puts).toEqual([ver("s", 7, "progress_stream"), ver("task", 2)]);
  });
});

describe("discard (plan 5.5.5; WEB-04 D:3281-3290)", () => {
  const base = (over: Partial<DraftRow> = {}) =>
    draftRow({
      local_id: "a",
      created_seq: 1,
      index_targets: ["r"],
      target_resource_ids: ["r"],
      bases: { r: 1 },
      bumped: ["r"],
      ...over,
    });
  const dependant = (
    id: string,
    on: string,
    seq: number,
    over: Partial<DraftRow> = {},
  ) =>
    draftRow({
      local_id: id,
      created_seq: seq,
      index_targets: ["r"],
      target_resource_ids: ["r"],
      bases: { r: seq },
      bumped: ["r"],
      depends_on: [on],
      ...over,
    });
  const ctx = (
    draft: DraftRow | undefined,
    dependants: DraftRow[] = [],
    effects = [effectRow({ local_id: "a", resource_id: "r" })],
  ) => ({
    draft,
    dependants,
    effects,
    others: [],
    cache: new Map([["r", cacheRow({ id: "r", version: 1 })]]),
    versions: new Map([
      ["r", versionRow({ resource_id: "r", locally_assumed_version: 3 })],
    ]),
  });

  test("a queued draft is REMOVED, every dependant becomes rejected and is kept, and the base is recomputed in the same step", () => {
    const a = base();
    const b = dependant("b", "a", 2);
    const c = dependant("c", "b", 3);
    const out = decideDiscard(ctx(a, [b, c]));
    if (out.kind !== "discarded") throw new Error(out.kind);
    expect(out.outcome).toBe("removed");
    expect(out.draftDeletes).toEqual(["a"]);
    expect(out.draftPuts.map((d) => [d.local_id, d.status])).toEqual([
      ["b", "rejected"],
      ["c", "rejected"],
    ]);
    expect(out.versions.puts).toEqual([
      { resource_id: "r", locally_assumed_version: 1, basis: "resource" },
    ]);
  });

  test("an explicit dismissal of a rejected row is a pure delete with NO recompute, and clears the entry its dependants hold", () => {
    const a = base({ status: "rejected" });
    const b = dependant("b", "a", 2, { status: "rejected" });
    const out = decideDiscard(ctx(a, [b]));
    if (out.kind !== "discarded") throw new Error(out.kind);
    expect(out.outcome).toBe("dismissed");
    expect(out.versions).toEqual({ puts: [], deletes: [] });
    expect(out.draftDeletes).toEqual(["a"]);
    expect(out.draftPuts[0]?.depends_on).toEqual([]);
  });

  test("an operation_conflict draft becomes rejected and STAYS (whether the first operation took effect is the person's to judge)", () => {
    const out = decideDiscard(ctx(base({ status: "operation_conflict" })));
    if (out.kind !== "discarded") throw new Error(out.kind);
    expect(out.outcome).toBe("retained");
    expect(out.draftDeletes).toEqual([]);
    expect(out.draftPuts[0]).toMatchObject({
      local_id: "a",
      status: "rejected",
    });
  });

  test.each([
    [
      "an in_flight draft with no review",
      base({ status: "in_flight" }),
      "in_flight",
    ],
    [
      "an acknowledged draft with nothing retained",
      base({ status: "acknowledged" }),
      "acknowledged",
    ],
  ])("%s is refused", (_n, draft, reason) => {
    expect(decideDiscard(ctx(draft))).toEqual({ kind: "refused", reason });
  });

  test("a defaults review (in_flight with a review block) was definitively not executed: it can be discarded", () => {
    const out = decideDiscard(
      ctx(
        base({
          status: "in_flight",
          review_block: { kind: "defaults", kinds: [] },
        }),
      ),
    );
    expect(out.kind).toBe("discarded");
  });

  test("a retained unavailable outcome is dismissible, a held-pending-cache receipt is not", () => {
    expect(
      decideDiscard(
        ctx(base({ status: "acknowledged", unavailable_outcome: true })),
      ).kind,
    ).toBe("discarded");
    expect(
      decideDiscard(
        ctx(base({ status: "acknowledged", held_pending_cache: true })),
      ).kind,
    ).toBe("refused");
  });

  test("a missing draft, and a dependant that is in flight (it would destroy a possibly executed command), are refused", () => {
    expect(decideDiscard(ctx(undefined))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(
      decideDiscard(
        ctx(base(), [dependant("b", "a", 2, { status: "in_flight" })]),
      ),
    ).toEqual({ kind: "refused", reason: "dependant_in_flight" });
  });
});

describe("supersede (WEB-04 D:3291-3350)", () => {
  const old = draftRow({
    local_id: "old",
    created_seq: 1,
    status: "version_conflict",
    index_targets: ["r"],
    target_resource_ids: ["r"],
    bases: { r: 2 },
    bumped: ["r"],
    expected_version: 2,
    depends_on: ["pred"],
  });
  const dep = draftRow({
    local_id: "dep",
    created_seq: 2,
    index_targets: ["r"],
    target_resource_ids: ["r"],
    bases: { r: 3 },
    bumped: ["r"],
    depends_on: ["old"],
  });
  const make = (over: Partial<Parameters<typeof decideSupersede>[1]> = {}) => ({
    old,
    // A fresh replacement key: nothing is stored under "new" (R24 added the fact; the cases below keep their meaning).
    existing: undefined,
    existingPaused: [],
    direct: [dep],
    cascade: [old, dep],
    effects: [effectRow({ local_id: "old", resource_id: "r" })],
    others: [],
    cache: new Map([["r", cacheRow({ id: "r", version: 2 })]]),
    versions: new Map([
      ["r", versionRow({ resource_id: "r", locally_assumed_version: 4 })],
    ]),
    sync: sync({ draft_seq: 2 }),
    localId: "new",
    accountId: "acct",
    now: NOW,
    ...over,
  });
  const req = request([primary("r")]);

  test("the replacement is built against the corrected record, takes the old draft's place, and the old row is deleted", () => {
    const out = decideSupersede(req, make());
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.draft).toMatchObject({
      local_id: "new",
      expected_version: 2,
      status: "queued",
      // It takes the old draft's place in the queue, so it stays ahead of the dependants it now stands behind.
      created_seq: 1,
      depends_on: ["pred"],
    });
    expect(out.draftDeletes).toEqual(["old"]);
    expect(out.effectDeletes).toEqual([["r", "old"]]);
    expect(out.versionPuts).toEqual([
      { resource_id: "r", locally_assumed_version: 3, basis: "resource" },
    ]);
  });

  test("every direct dependant is retargeted to the new id; a version conflict's supersession pauses it for review", () => {
    const out = decideSupersede(req, make());
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.draftPuts).toHaveLength(1);
    expect(out.draftPuts[0]).toMatchObject({
      local_id: "dep",
      depends_on: ["new"],
      status: "version_conflict",
    });
    expect(out.paused).toEqual(["dep"]);
  });

  test("an operation conflict's re-expression does NOT pause a dependant when the resulting version is unchanged", () => {
    const out = decideSupersede(
      req,
      make({ old: { ...old, status: "operation_conflict" } }),
    );
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.paused).toEqual([]);
    expect(out.draftPuts[0]).toMatchObject({
      depends_on: ["new"],
      status: "queued",
    });
  });

  test("...but it DOES when the replacement's assumed version differs (this layer cannot rewrite a body it does not understand)", () => {
    const out = decideSupersede(
      req,
      make({
        old: { ...old, status: "operation_conflict" },
        cache: new Map([["r", cacheRow({ id: "r", version: 9 })]]),
      }),
    );
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.paused).toEqual(["dep"]);
  });

  test.each(["queued", "acknowledged", "rejected", "blocked"] as const)(
    "a %s draft is not supersedable",
    (status) => {
      expect(decideSupersede(req, make({ old: { ...old, status } }))).toEqual({
        kind: "refused",
        reason: "not_supersedable",
      });
    },
  );

  test("a defaults review (in_flight with a block) is supersedable; a missing draft and a fence are refused", () => {
    expect(
      decideSupersede(
        req,
        make({
          old: {
            ...old,
            status: "in_flight",
            review_block: { kind: "defaults", kinds: [] },
          },
        }),
      ).kind,
    ).toBe("superseded");
    expect(decideSupersede(req, make({ old: undefined }))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(
      decideSupersede(
        req,
        make({
          sync: sync({
            draft_fence: {
              token: "t",
              started_at: 1,
              operation_ids: ["o"],
              consent_digest: "d",
              closing: false,
            },
          }),
        }),
      ),
    ).toEqual({ kind: "refused", reason: "fenced" });
  });
});

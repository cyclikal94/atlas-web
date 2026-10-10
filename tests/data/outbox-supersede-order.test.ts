// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  decideSupersede,
  type EnqueueRequest,
  isTerminal,
  type SupersedeFacts,
  type TargetSpec,
} from "../../src/data/model/outbox";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { DraftRow, SyncStateRow } from "../../src/data/model/types";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow, versionRow } from "../support/data/rows";

/**
 * R45 (revision 25): a supersession must leave the queue in an order every draft can follow.
 *
 * `supersede` stored the replacement at the OLD draft's `created_seq`, with the dependencies derived from the queue as it is NOW. A
 * draft enqueued after the old one for a target the replacement newly used is then both a prerequisite of the replacement (it is the
 * latest draft against that target, and the replacement's base counts its contribution) and a draft the dispatcher holds behind the
 * replacement (the replacement is older and shares the target). Neither could ever be sent: the replacement was reported saved and the
 * dispatcher went idle with `pick: null`.
 *
 * THE INVARIANT: every `depends_on` entry names an OLDER draft, and `created_seq` is unique at rest. The audit of the same boundary
 * (every way a replacement can differ from the draft it replaces) found four more arrangements that broke it or the version bases:
 * an explicit dependency on a dependant of the old draft (a cycle), an explicit dependency on a newer draft, a target the replacement
 * raises where the old draft did not and a dependant of the old draft also touches (its base holds the dependant's own contribution),
 * and a dependant that stays queued (the record fell below what it stands on, so the next save was based on a version it is about to
 * raise); a target or side effect the replacement dropped did not pause the dependants that stood on it.
 *
 * Three layers: the pure decision, the production facade/plans/dispatcher over the double of IndexedDB (the reviewer's arrangements,
 * a restart and ten minutes), and a seeded random program that checks the invariant after every step and that no draft is left waiting
 * on drafts that all wait on it. FIXTURE evidence: the double of the store and a scripted server, not the released backend.
 */
const NOW = "2026-10-01T10:00:00.000Z";
const sync = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
  ...initialSyncState("inc"),
  phase: "delta",
  cache_status: "valid",
  ...over,
});

const primary = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: true,
  ...over,
});
const sideEffect = (id: string): TargetSpec => ({
  resourceId: id,
  role: "side_effect",
  basis: "resource",
  versionChecked: true,
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

// ---- the pure decision ----------------------------------------------------------------------------------------------------------
/**
 * The queue: `old` (seq 1, an operation conflict on `r`, version 5 raised to 6), `dep` (seq 3, stands on `r` behind `old`, raises it to 7),
 * and `later` (seq 2, an unrelated draft on `s`, raises it from 5 to 6). The counter is at 3.
 */
const old = (over: Partial<DraftRow> = {}): DraftRow =>
  draftRow({
    local_id: "old",
    created_seq: 1,
    status: "operation_conflict",
    index_targets: ["r"],
    target_resource_ids: ["r"],
    bases: { r: 5 },
    bumped: ["r"],
    expected_version: 5,
    ...over,
  });
const dep = (over: Partial<DraftRow> = {}): DraftRow =>
  draftRow({
    local_id: "dep",
    created_seq: 3,
    index_targets: ["r"],
    target_resource_ids: ["r"],
    bases: { r: 6 },
    bumped: ["r"],
    expected_version: 6,
    depends_on: ["old"],
    ...over,
  });
const later = (over: Partial<DraftRow> = {}): DraftRow =>
  draftRow({
    local_id: "later",
    created_seq: 2,
    index_targets: ["s"],
    target_resource_ids: ["s"],
    bases: { s: 5 },
    bumped: ["s"],
    expected_version: 5,
    ...over,
  });

interface Shape {
  old?: DraftRow;
  /** The old draft's dependants, in the order of the cascade (the cascade lists `old` first). */
  dependants?: DraftRow[];
  others?: DraftRow[];
  extras?: DraftRow[];
  versions?: Record<string, number>;
}
const make = (shape: Shape = {}): SupersedeFacts => {
  const oldRow = shape.old ?? old();
  const dependants = shape.dependants ?? [];
  const versions = shape.versions ?? { r: 6, s: 6 };
  return {
    old: oldRow,
    existing: undefined,
    existingPaused: [],
    direct: dependants.filter((row) => row.depends_on.includes("old")),
    cascade: [oldRow, ...dependants],
    ...(shape.extras === undefined ? {} : { extras: shape.extras }),
    effects: [],
    others: shape.others ?? [],
    cache: new Map([
      ["r", cacheRow({ id: "r", version: 5 })],
      ["s", cacheRow({ id: "s", version: 5 })],
    ]),
    versions: new Map(
      Object.entries(versions).map(([id, value]) => [
        id,
        versionRow({ resource_id: id, locally_assumed_version: value }),
      ]),
    ),
    sync: sync({ draft_seq: 3 }),
    localId: "new",
    accountId: "acct",
    now: NOW,
  };
};
const decide = (req: EnqueueRequest, shape: Shape = {}) =>
  decideSupersede(req, make(shape));
const superseded = (out: ReturnType<typeof decide>) => {
  // An assertion first: a refusal is the test saying the decision is wrong, not a crash of the test.
  expect(out, JSON.stringify(out)).toMatchObject({ kind: "superseded" });
  if (out.kind !== "superseded") throw new Error(JSON.stringify(out));
  return out;
};
const refusal = { kind: "refused", reason: "order_conflict" } as const;

describe("R45: where the replacement stands (the pure decision)", () => {
  test("nothing it waits for is newer: it takes the old draft's place, consumes no sequence number and writes no counter", () => {
    const out = superseded(
      decide(request([primary("r")]), { dependants: [dep()] }),
    );
    expect(out.draft.created_seq).toBe(1);
    expect(out.sync).toBeUndefined();
    expect(out.draft.depends_on).toEqual([]);
  });

  test("an unoccupied new target keeps the place as well (the reviewer's control)", () => {
    const out = superseded(
      decide(request([primary("t", { seedIfUntracked: 1 })]), { versions: {} }),
    );
    expect(out.draft.created_seq).toBe(1);
    expect(out.sync).toBeUndefined();
  });

  test("a newer draft against a NEW primary target: the replacement takes the END of the queue, behind it, and writes the counter", () => {
    const out = superseded(
      decide(request([primary("s")]), { others: [later()] }),
    );
    // The base counts the newer draft's contribution (5 + 1): the replacement stands after it, and now it is in the order too.
    expect(out.draft.bases).toEqual({ s: 6 });
    expect(out.draft.depends_on).toEqual(["later"]);
    expect(out.draft.created_seq).toBe(4);
    expect(out.sync?.draft_seq).toBe(4);
    expect(out.draft.created_seq).toBeGreaterThan(later().created_seq);
  });

  test("the same for a side effect the replacement adds (the old draft's own target is kept)", () => {
    const out = superseded(
      decide(request([primary("r"), sideEffect("s")]), { others: [later()] }),
    );
    expect(out.draft.depends_on).toEqual(["later"]);
    expect(out.draft.created_seq).toBe(4);
    expect(out.sync?.draft_seq).toBe(4);
    expect(out.draft.index_targets).toEqual(["r", "s"]);
  });

  test("a newer draft but a DEPENDANT of the old draft that has to stay behind the replacement: refused, with nothing to write", () => {
    expect(
      decide(request([primary("s")]), {
        others: [later()],
        dependants: [dep()],
      }),
    ).toEqual(refusal);
    expect(
      decide(request([primary("r"), sideEffect("s")]), {
        others: [later()],
        dependants: [dep()],
      }),
    ).toEqual(refusal);
  });

  test("a dependant that is already terminal does not stand behind anything: the replacement may move", () => {
    for (const status of ["rejected", "acknowledged"] as const) {
      const out = superseded(
        decide(request([primary("s")]), {
          others: [later()],
          dependants: [dep({ status })],
        }),
      );
      expect(out.draft.created_seq).toBe(4);
    }
  });

  test("a newer draft that is itself terminal is nothing to wait for (a derived dependency never names one, so it is an explicit one): the replacement keeps its place", () => {
    for (const status of ["acknowledged", "rejected"] as const) {
      const out = superseded(
        decide(request([primary("r")], { dependsOnExtra: ["later"] }), {
          extras: [later({ status })],
          dependants: [dep()],
        }),
      );
      expect(out.draft.created_seq).toBe(1);
      expect(out.sync).toBeUndefined();
      expect(out.draft.depends_on).toEqual(["later"]);
    }
  });

  test("an older draft against the new target is a plain dependency: the place is kept", () => {
    const out = superseded(
      decide(request([primary("s")]), {
        others: [later({ created_seq: 0 })],
        dependants: [dep()],
      }),
    );
    expect(out.draft.depends_on).toEqual(["later"]);
    expect(out.draft.created_seq).toBe(1);
  });

  test("an explicit dependency on a draft that waits for the old one is a CYCLE: refused, whatever else holds", () => {
    expect(
      decide(request([primary("r")], { dependsOnExtra: ["dep"] }), {
        dependants: [dep()],
      }),
    ).toEqual(refusal);
    // A dependant further down the chain is as much a dependant.
    expect(
      decide(request([primary("r")], { dependsOnExtra: ["far"] }), {
        dependants: [
          dep(),
          dep({ local_id: "far", created_seq: 4, depends_on: ["dep"] }),
        ],
      }),
    ).toEqual(refusal);
  });

  test("an explicit dependency on a TERMINAL dependant is no cycle", () => {
    const out = superseded(
      decide(request([primary("r")], { dependsOnExtra: ["dep"] }), {
        dependants: [dep({ status: "rejected" })],
      }),
    );
    expect(out.draft.created_seq).toBe(1);
  });

  test("an explicit dependency on a newer draft is placed like a derived one: the end, or refused with dependants behind", () => {
    const named = request([primary("r")], { dependsOnExtra: ["later"] });
    const moved = superseded(decide(named, { extras: [later()] }));
    expect(moved.draft.depends_on).toEqual(["later"]);
    expect(moved.draft.created_seq).toBe(4);
    expect(moved.sync?.draft_seq).toBe(4);
    expect(decide(named, { extras: [later()], dependants: [dep()] })).toEqual(
      refusal,
    );
  });

  test("an explicit dependency on an older, a missing or a settled draft keeps the place", () => {
    for (const extras of [
      [later({ created_seq: 0 })],
      [],
      [later({ status: "rejected" })],
    ]) {
      const out = superseded(
        decide(request([primary("r")], { dependsOnExtra: ["later"] }), {
          extras,
          dependants: [dep()],
        }),
      );
      expect(out.draft.created_seq).toBe(1);
      expect(out.draft.depends_on).toEqual(["later"]);
    }
  });

  test("a target the replacement RAISES where the old draft did not, and a dependant touches it: refused", () => {
    // `dep` also stands on `s`: its base for `s` was read from a record that holds its own contribution.
    const both = dep({
      index_targets: ["r", "s"],
      bases: { r: 6, s: 5 },
      bumped: ["r", "s"],
    });
    expect(
      decide(request([primary("r"), sideEffect("s")]), { dependants: [both] }),
    ).toEqual(refusal);
    // A non-bumping touch of the same id is touched all the same.
    expect(
      decide(request([primary("r"), sideEffect("s")]), {
        dependants: [dep({ index_targets: ["r", "s"], bases: { r: 6, s: 5 } })],
      }),
    ).toEqual(refusal);
    // A primary that the old draft only touched is now raised: the same.
    expect(
      decide(request([primary("r"), primary("t", { versionChecked: false })]), {
        dependants: [dep()],
        old: old({ index_targets: ["r", "t"] }),
      }).kind,
    ).toBe("superseded");
  });

  test("the same target when the dependant does not touch it, or when the old draft raised it too, is admitted in place", () => {
    const out = superseded(
      decide(request([primary("r"), sideEffect("s")]), {
        dependants: [dep()],
      }),
    );
    expect(out.draft.created_seq).toBe(1);
    const both = old({
      index_targets: ["r", "s"],
      bases: { r: 5, s: 5 },
      bumped: ["r", "s"],
    });
    const sharing = dep({
      index_targets: ["r", "s"],
      bases: { r: 6, s: 6 },
      bumped: ["r", "s"],
    });
    const kept = superseded(
      decide(request([primary("r"), sideEffect("s")]), {
        old: both,
        dependants: [sharing],
        versions: { r: 7, s: 7 },
      }),
    );
    expect(kept.draft.created_seq).toBe(1);
    expect(kept.paused).toEqual([]);
  });
});

describe("R45: what the dependants stand on (version bases)", () => {
  test("a dependant is paused when the replacement drops a side effect the old draft raised and the dependant stands on", () => {
    const both = old({
      index_targets: ["r", "s"],
      bases: { r: 5, s: 5 },
      bumped: ["r", "s"],
    });
    const onSide = dep({
      index_targets: ["s"],
      target_resource_ids: ["s"],
      bases: { s: 6 },
      bumped: ["s"],
    });
    const out = superseded(
      decide(request([primary("r")]), {
        old: both,
        dependants: [onSide],
        versions: { r: 6, s: 7 },
      }),
    );
    // Revision 24 left it `queued`: it would have been sent on a version the replacement never produces.
    expect(out.paused).toEqual(["dep"]);
    expect(out.draftPuts[0]).toMatchObject({
      local_id: "dep",
      status: "version_conflict",
      depends_on: ["new"],
    });
  });

  test("a dependant is paused when the replacement stops raising the version of a target it still touches", () => {
    const out = superseded(
      decide(request([primary("r", { versionChecked: false })]), {
        dependants: [dep()],
      }),
    );
    expect(out.paused).toEqual(["dep"]);
  });

  test("the same bases and the same raises pause nothing; another base pauses (the earlier rule is kept)", () => {
    expect(
      superseded(decide(request([primary("r")]), { dependants: [dep()] }))
        .paused,
    ).toEqual([]);
    const cache = make({ dependants: [dep()] });
    const moved = decideSupersede(request([primary("r")]), {
      ...cache,
      cache: new Map([["r", cacheRow({ id: "r", version: 9 })]]),
    });
    expect(superseded(moved).paused).toEqual(["dep"]);
  });

  test("a dependant that stays queued keeps the record at what it stands on, and transitive ones count", () => {
    const far = dep({
      local_id: "far",
      created_seq: 4,
      depends_on: ["dep"],
      bases: { r: 7 },
      expected_version: 7,
    });
    const out = superseded(
      decide(request([primary("r")]), {
        dependants: [dep(), far],
        versions: { r: 8 },
      }),
    );
    expect(out.paused).toEqual([]);
    // The replacement raises 5 to 6, `dep` 6 to 7, `far` 7 to 8: the record is 8, not the replacement's 6 (revision 24).
    expect(out.versionPuts).toEqual([
      { resource_id: "r", locally_assumed_version: 8, basis: "resource" },
    ]);
  });

  test("a dependant that is paused leaves the record at the replacement's result (its resolution recomputes from its bases)", () => {
    const out = superseded(
      decide(request([primary("r")]), {
        old: old({ status: "version_conflict" }),
        dependants: [dep()],
        versions: { r: 7 },
      }),
    );
    expect(out.paused).toEqual(["dep"]);
    expect(out.versionPuts).toEqual([
      { resource_id: "r", locally_assumed_version: 6, basis: "resource" },
    ]);
  });
});

// ---- the production facade and dispatcher ---------------------------------------------------------------------------------------
const edit = (
  id: string,
  localId: string,
  more: { side?: string[]; after?: string[] } = {},
): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  ...(more.after === undefined ? {} : { dependsOnExtra: more.after }),
  targets: [
    primary(id),
    ...(more.side ?? []).map((target) => sideEffect(target)),
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id,
      expected_version: bases[id] as number,
      label: localId,
    },
  }),
});

type Cause = "conflict" | "operation_conflict" | "defaults_changed";
const CAUSES: Cause[] = ["conflict", "operation_conflict", "defaults_changed"];

/** `old` (on `r`) answered with `cause`, the dispatcher then offline, as the reviewer's probe arranges it. */
async function conflicted(
  cause: Cause,
  options: { oldSide?: string[] } = {},
): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "s", version: 5 }),
    cacheRow({ id: "t", version: 5 }),
  ]);
  expect(
    (await w.outbox.enqueue(edit("r", "old", { side: options.oldSide }))).kind,
  ).toBe("queued");
  w.script.push(w.error(409, cause));
  w.start();
  await w.settle();
  const row = w.drafts().find((draft) => draft.local_id === "old");
  if (cause === "defaults_changed") {
    expect(row?.status).toBe("in_flight");
    expect(row?.review_block).not.toBeNull();
  } else
    expect(row?.status).toBe(
      cause === "conflict" ? "version_conflict" : "operation_conflict",
    );
  w.online = false;
  w.fire();
  await w.settle();
  return w;
}

const STORES = [
  "drafts",
  "draft_commands",
  "pending_effects",
  "resource_versions",
  "sync_state",
] as const;
const everything = (w: OutboxWorld) => {
  const snapshot = w.snapshot() ?? {};
  return Object.fromEntries(STORES.map((name) => [name, snapshot[name]]));
};
const finish = (w: OutboxWorld) => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const status = (w: OutboxWorld, id: string) =>
  w.drafts().find((draft) => draft.local_id === id)?.status;

/** The invariant: unique `created_seq`, a counter that has not been passed by any row, and every unsettled dependency of an unsettled draft strictly OLDER. */
function assertOrdered(w: OutboxWorld, context = ""): void {
  const rows = w.drafts();
  const seqs = rows.map((row) => row.created_seq);
  expect(new Set(seqs).size, "created_seq is unique at rest").toBe(seqs.length);
  expect(
    w.sync().draft_seq,
    "the counter is ahead of every row",
  ).toBeGreaterThanOrEqual(Math.max(0, ...seqs));
  const byId = new Map(rows.map((row) => [row.local_id, row]));
  // Only a draft that can still be sent waits: a settled row (a retained rejection, say) may name any draft and is never sent.
  for (const row of rows.filter((candidate) => !isTerminal(candidate)))
    for (const id of row.depends_on) {
      const dependency = byId.get(id);
      if (dependency !== undefined && !isTerminal(dependency))
        expect(
          dependency.created_seq,
          `${context} ${row.local_id} (seq ${row.created_seq}, ${row.status}) waits for ${id}, which must be older: ${JSON.stringify(
            rows.map((r) => [
              r.local_id,
              r.created_seq,
              r.status,
              r.depends_on,
              r.index_targets,
            ]),
          )}`,
        ).toBeLessThan(row.created_seq);
    }
}

describe("R45: the reviewer's arrangements, through the production facade and dispatcher, with a restart", () => {
  for (const cause of CAUSES) {
    test.each([
      "same-target-control",
      "retarget-empty-control",
      "retarget-occupied",
      "add-side-effect",
    ] as const)(`%s after a ${cause}`, async (mode) => {
      const w = await conflicted(cause);
      if (mode !== "retarget-empty-control")
        expect(
          (
            await w.outbox.enqueue(
              edit(mode === "same-target-control" ? "r" : "s", "later"),
            )
          ).kind,
        ).toBe("queued");
      const next = edit(
        mode === "same-target-control" || mode === "add-side-effect"
          ? "r"
          : "s",
        "replacement",
        { side: mode === "add-side-effect" ? ["s"] : [] },
      );
      expect((await w.outbox.supersede("old", next)).kind).toBe("superseded");
      assertOrdered(w);
      const occupied =
        mode === "retarget-occupied" || mode === "add-side-effect";
      if (occupied) {
        // Behind the later save, where its bases already put it; the later save is not delayed by it.
        const rows = w.drafts();
        const replacement = rows.find((row) => row.local_id === "replacement");
        const earlier = rows.find((row) => row.local_id === "later");
        expect(replacement?.depends_on).toContain("later");
        expect(replacement?.created_seq).toBeGreaterThan(
          earlier?.created_seq ?? 0,
        );
      }
      const written = everything(w);

      w.goOnline();
      await w.settle();
      await w.advance(600_000);
      expect(status(w, "replacement")).toBe("acknowledged");
      if (mode !== "retarget-empty-control")
        expect(status(w, "later")).toBe(
          mode === "same-target-control" && cause === "conflict"
            ? "version_conflict"
            : "acknowledged",
        );
      if (occupied)
        expect(w.sent.map((request) => request.key).slice(-2)).toEqual([
          "later",
          "replacement",
        ]);
      assertOrdered(w);

      // A restart: nothing in memory survives, the rows decide. The dispatcher has nothing left to send.
      const rowsBefore = everything(w);
      w.reload();
      w.start();
      await w.settle();
      expect(everything(w)).toEqual(rowsBefore);
      expect(written).not.toEqual(rowsBefore);
      finish(w);
    });
  }

  test.each(CAUSES)(
    "%s: a restart BEFORE anything is sent keeps the replacement behind the later save and sends both",
    async (cause) => {
      const w = await conflicted(cause);
      await w.outbox.enqueue(edit("s", "later"));
      expect(
        (await w.outbox.supersede("old", edit("s", "replacement"))).kind,
      ).toBe("superseded");
      const written = everything(w);
      w.reload();
      expect(everything(w)).toEqual(written);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(600_000);
      expect(status(w, "later")).toBe("acknowledged");
      expect(status(w, "replacement")).toBe("acknowledged");
      assertOrdered(w);
      finish(w);
    },
  );

  test("a moved replacement consumes exactly ONE sequence number: the next save has the next one and nothing else is renumbered", async () => {
    const w = await conflicted("operation_conflict");
    await w.outbox.enqueue(edit("s", "later"));
    const counter = w.sync().draft_seq;
    const before = new Map(
      w.drafts().map((row) => [row.local_id, row.created_seq]),
    );
    await w.outbox.supersede("old", edit("s", "replacement"));
    expect(w.sync().draft_seq).toBe(counter + 1);
    const after = new Map(
      w.drafts().map((row) => [row.local_id, row.created_seq]),
    );
    expect(after.get("later")).toBe(before.get("later"));
    expect(after.get("replacement")).toBe(counter + 1);
    const next = await w.outbox.enqueue(edit("t", "next"));
    expect(next).toMatchObject({ kind: "queued", createdSeq: counter + 2 });
    assertOrdered(w);
    // A supersession that keeps the place does not move the counter.
    const place = w.sync().draft_seq;
    const w2 = await conflicted("operation_conflict");
    const start = w2.sync().draft_seq;
    await w2.outbox.supersede("old", edit("r", "replacement"));
    expect(w2.sync().draft_seq).toBe(start);
    expect(
      w2.drafts().find((row) => row.local_id === "replacement")?.created_seq,
    ).toBe(1);
    expect(place).toBeGreaterThan(start);
    finish(w);
    finish(w2);
  });
});

describe("R45: a request that cannot be placed is REFUSED and the old draft is not retired", () => {
  test.each(CAUSES)(
    "%s: a newer draft and a dependant behind the replacement: refused, every store as it was, then the person's own ways forward work",
    async (cause) => {
      const w = await conflicted(cause);
      await w.outbox.enqueue(edit("r", "dependant"));
      await w.outbox.enqueue(edit("s", "later"));
      const before = everything(w);
      const refused = await w.outbox.supersede("old", edit("s", "replacement"));
      expect(refused).toEqual({ kind: "refused", reason: "order_conflict" });
      expect(everything(w)).toEqual(before);
      expect(
        await w.outbox.supersede("old", edit("r", "again", { side: ["s"] })),
      ).toEqual({ kind: "refused", reason: "order_conflict" });
      expect(everything(w)).toEqual(before);
      assertOrdered(w);

      w.goOnline();
      await w.settle();
      if (cause === "defaults_changed") {
        // A defaults review holds the queue behind it (D-19): the later save is not sent while the review stands, so the request cannot
        // become placeable by waiting. The person's own ways forward are the next test.
        expect(status(w, "later")).toBe("queued");
        expect(w.sent.some((request) => request.key === "later")).toBe(false);
        expect(everything(w)).toEqual(before);
        finish(w);
        return;
      }
      // The refusal is not permanent: once the later save is settled the same request is admitted, in the old draft's place.
      expect(status(w, "later")).toBe("acknowledged");
      expect(status(w, "old")).toBeDefined();
      const retried = await w.outbox.supersede("old", edit("s", "replacement"));
      expect(retried).toMatchObject({
        kind: "superseded",
        localId: "replacement",
      });
      expect(
        w.drafts().find((row) => row.local_id === "replacement")?.created_seq,
      ).toBe(1);
      assertOrdered(w);
      await w.settle();
      await w.advance(600_000);
      expect(status(w, "replacement")).toBe("acknowledged");
      finish(w);
    },
  );

  test.each(CAUSES)(
    "%s: the person's other way forward: discarding the old draft rejects its dependant and frees the later save",
    async (cause) => {
      const w = await conflicted(cause);
      await w.outbox.enqueue(edit("r", "dependant"));
      await w.outbox.enqueue(edit("s", "later"));
      expect(
        (await w.outbox.supersede("old", edit("s", "replacement"))).kind,
      ).toBe("refused");
      const discarded = await w.outbox.discard("old");
      expect(discarded).toMatchObject({ kind: "discarded", affected: 1 });
      expect(status(w, "dependant")).toBe("rejected");
      // The same request is now a plain save: no old draft to replace, so it is `not_found`, and the person saves it as a new draft.
      expect(
        (await w.outbox.supersede("old", edit("s", "replacement"))).kind,
      ).toBe("refused");
      expect((await w.outbox.enqueue(edit("s", "replacement"))).kind).toBe(
        "queued",
      );
      w.goOnline();
      await w.settle();
      expect(status(w, "later")).toBe("acknowledged");
      expect(status(w, "replacement")).toBe("acknowledged");
      assertOrdered(w);
      finish(w);
    },
  );

  test("a target the replacement raises where the old draft did not, which the old draft's dependant touches: refused", async () => {
    const w = await conflicted("operation_conflict");
    await w.outbox.enqueue(edit("r", "dependant", { side: ["s"] }));
    const before = everything(w);
    expect(
      await w.outbox.supersede(
        "old",
        edit("r", "replacement", { side: ["s"] }),
      ),
    ).toEqual({ kind: "refused", reason: "order_conflict" });
    expect(everything(w)).toEqual(before);
    // Without the dependant on `s` the same side effect is admitted in place.
    const w2 = await conflicted("operation_conflict");
    await w2.outbox.enqueue(edit("r", "dependant"));
    expect(
      (
        await w2.outbox.supersede(
          "old",
          edit("r", "replacement", { side: ["s"] }),
        )
      ).kind,
    ).toBe("superseded");
    assertOrdered(w2);
    w2.goOnline();
    await w2.settle();
    expect(status(w2, "replacement")).toBe("acknowledged");
    expect(status(w2, "dependant")).toBe("acknowledged");
    finish(w);
    finish(w2);
  });

  test("an explicit dependency on a dependant of the old draft is a cycle and is refused; on a newer unrelated draft it goes to the end", async () => {
    const w = await conflicted("operation_conflict");
    await w.outbox.enqueue(edit("r", "dependant"));
    await w.outbox.enqueue(edit("s", "later"));
    const before = everything(w);
    expect(
      await w.outbox.supersede(
        "old",
        edit("r", "cycle", { after: ["dependant"] }),
      ),
    ).toEqual({ kind: "refused", reason: "order_conflict" });
    expect(
      await w.outbox.supersede(
        "old",
        edit("r", "inverted", { after: ["later"] }),
      ),
    ).toEqual({ kind: "refused", reason: "order_conflict" });
    expect(everything(w)).toEqual(before);

    // With no dependant to stay ahead of, the explicit dependency on a newer draft is honoured by going behind it.
    const w2 = await conflicted("operation_conflict");
    await w2.outbox.enqueue(edit("s", "later"));
    expect(
      (
        await w2.outbox.supersede(
          "old",
          edit("r", "behind", { after: ["later"] }),
        )
      ).kind,
    ).toBe("superseded");
    assertOrdered(w2);
    w2.goOnline();
    await w2.settle();
    expect(w2.sent.map((request) => request.key).slice(-2)).toEqual([
      "later",
      "behind",
    ]);
    expect(status(w2, "behind")).toBe("acknowledged");
    finish(w);
    finish(w2);
  });
});

describe("R45: the version bases after a supersession that has dependants", () => {
  test("a dependant that stays queued: the record keeps its contribution, so the next save is based on the version the dependant leaves", async () => {
    const w = await conflicted("operation_conflict");
    await w.outbox.enqueue(edit("r", "dependant"));
    const before = w.versions().find((row) => row.resource_id === "r");
    expect(before?.locally_assumed_version).toBe(7);
    expect(
      (await w.outbox.supersede("old", edit("r", "replacement"))).kind,
    ).toBe("superseded");
    // Revision 24 wrote 6 here: the next save then expected the version the dependant is about to raise, and the server refused it.
    expect(
      w.versions().find((row) => row.resource_id === "r")
        ?.locally_assumed_version,
    ).toBe(7);
    await w.outbox.enqueue(edit("r", "next"));
    expect(w.drafts().find((row) => row.local_id === "next")?.bases).toEqual({
      r: 7,
    });
    w.goOnline();
    await w.settle();
    const bodies = w.sent.map(
      (request) => JSON.parse(request.body).expected_version,
    );
    expect(bodies.slice(-3)).toEqual([5, 6, 7]);
    finish(w);
  });

  test("a dropped side effect pauses the dependant that stands on it and leaves the record at what is real", async () => {
    const w = await conflicted("operation_conflict", { oldSide: ["s"] });
    await w.outbox.enqueue(edit("s", "dependant"));
    const out = await w.outbox.supersede("old", edit("r", "replacement"));
    expect(out).toMatchObject({ kind: "superseded", paused: ["dependant"] });
    expect(status(w, "dependant")).toBe("version_conflict");
    expect(
      w.versions().find((row) => row.resource_id === "s")
        ?.locally_assumed_version,
    ).toBe(5);
    assertOrdered(w);
    w.goOnline();
    await w.settle();
    // Nothing was sent for the paused draft: it needs the person.
    expect(w.sent.some((request) => request.key === "dependant")).toBe(false);
    finish(w);
  });
});

// ---- a seeded random program ----------------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERSON = new Set(["version_conflict", "operation_conflict", "blocked"]);

/** Whether a draft that is still waiting waits (however indirectly) for a draft that is waiting for the PERSON. */
function waitsForPerson(rows: DraftRow[], row: DraftRow): boolean {
  const seen = new Set<string>();
  const stack = [row];
  const byId = new Map(rows.map((r) => [r.local_id, r]));
  while (stack.length > 0) {
    const at = stack.pop() as DraftRow;
    if (seen.has(at.local_id)) continue;
    seen.add(at.local_id);
    if (at !== row && (PERSON.has(at.status) || at.review_block !== null))
      return true;
    for (const id of at.depends_on) {
      const dependency = byId.get(id);
      if (dependency !== undefined && !isTerminal(dependency))
        stack.push(dependency);
    }
    for (const other of rows)
      if (
        !isTerminal(other) &&
        other.created_seq < at.created_seq &&
        other.index_targets.some((id) => at.index_targets.includes(id))
      )
        stack.push(other);
    // A queue held behind a defaults review waits for it.
    for (const other of rows)
      if (
        other.review_block !== null &&
        !isTerminal(other) &&
        other.created_seq < at.created_seq
      )
        return true;
  }
  return false;
}

describe("R45: a seeded random program never leaves the queue unordered or unsendable", () => {
  const SEEDS = 300;
  const STEPS = 30;
  const IDS = ["a", "b", "c", "d"];
  test(`${SEEDS} programs of ${STEPS} steps: the invariant after every step; after the drain every waiting draft waits for the person`, async () => {
    const outcomes = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const random = rng(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(random() * items.length)] as T;
      const w = await outboxWorld();
      w.put(
        "cache",
        IDS.map((id) => cacheRow({ id, version: 5 })),
      );
      let n = 0;
      const key = (): string => {
        n += 1;
        return `d${n}`;
      };
      const tally = (kind: string) =>
        outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
      for (let step = 0; step < STEPS; step += 1) {
        const rows = w.drafts();
        const live = rows.filter((row) => !isTerminal(row));
        const roll = random();
        if (roll < 0.4 || live.length === 0) {
          const primaryId = pick(IDS);
          const extra =
            random() < 0.35 ? pick(IDS.filter((id) => id !== primaryId)) : null;
          const after =
            live.length > 0 && random() < 0.15
              ? [pick(live).local_id]
              : undefined;
          const out = await w.outbox.enqueue(
            edit(primaryId, key(), {
              side: extra === null ? [] : [extra],
              after,
            }),
          );
          tally(`enqueue:${out.kind}`);
        } else if (roll < 0.62) {
          // Arrange a conflict the dispatcher could really have produced: a draft that nothing older holds back.
          const free = live.filter(
            (row) =>
              row.status === "queued" &&
              row.review_block === null &&
              !live.some(
                (other) =>
                  other !== row &&
                  other.created_seq < row.created_seq &&
                  (row.depends_on.includes(other.local_id) ||
                    other.index_targets.some((id) =>
                      row.index_targets.includes(id),
                    )),
              ),
          );
          if (free.length === 0) continue;
          const row = pick(free);
          const cause = pick([
            "version_conflict",
            "operation_conflict",
            "review",
          ] as const);
          w.put("drafts", [
            cause === "review"
              ? {
                  ...row,
                  status: "in_flight",
                  review_block: { kind: "defaults", kinds: [] },
                }
              : { ...row, status: cause },
          ]);
          tally(`arrange:${cause}`);
        } else if (roll < 0.9) {
          const candidates = live.filter(
            (row) =>
              row.status === "version_conflict" ||
              row.status === "operation_conflict" ||
              (row.status === "in_flight" && row.review_block !== null),
          );
          if (candidates.length === 0) continue;
          const row = pick(candidates);
          const primaryId = pick(IDS);
          const extra =
            random() < 0.4 ? pick(IDS.filter((id) => id !== primaryId)) : null;
          const others = live.filter((r) => r.local_id !== row.local_id);
          const after =
            others.length > 0 && random() < 0.2
              ? [pick(others).local_id]
              : undefined;
          const out = await w.outbox.supersede(
            row.local_id,
            edit(primaryId, key(), {
              side: extra === null ? [] : [extra],
              after,
            }),
          );
          tally(`supersede:${out.kind === "refused" ? out.reason : out.kind}`);
        } else {
          const row = pick(live);
          const out = await w.outbox.discard(row.local_id);
          tally(`discard:${out.kind}`);
        }
        assertOrdered(w, `seed ${seed} step ${step} (${roll.toFixed(2)}):`);
      }
      // The drain: everything the dispatcher may send is sent. What remains must wait for the person, directly or not.
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(600_000);
      assertOrdered(w);
      const rows = w.drafts();
      for (const row of rows)
        if (
          row.status === "queued" ||
          (row.status === "in_flight" && row.review_block === null)
        )
          expect(
            waitsForPerson(rows, row),
            `seed ${seed}: ${row.local_id} (${row.status}, seq ${row.created_seq}) waits for nothing the person can resolve: ${JSON.stringify(
              rows.map((r) => [
                r.local_id,
                r.created_seq,
                r.status,
                r.depends_on,
              ]),
            )}`,
          ).toBe(true);
      // A restart reads the same queue.
      const rowsBefore = everything(w);
      w.reload();
      w.start();
      await w.settle();
      expect(everything(w)).toEqual(rowsBefore);
      finish(w);
    }
    // The program must actually have exercised the paths it is there for.
    expect(outcomes.get("supersede:superseded") ?? 0).toBeGreaterThan(150);
    expect(outcomes.get("supersede:order_conflict") ?? 0).toBeGreaterThan(30);
  }, 240_000);
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type Mention,
  OUTSTANDING,
  type PageFacts,
  type Reconciled,
  reconcilePage,
} from "../../src/data/model/reconcile";
import { accountDatabaseName } from "../../src/data/model/schema";
import type {
  DraftRow,
  DraftWithCommand,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../src/data/model/types";
import {
  interestingOf,
  reconcileInWindows,
} from "../../src/data/plans/reconcile-windows";
import type { Plan } from "../../src/data/store/port";
import { DataTestWorld } from "../support/data/env";
import {
  byKey,
  expected,
  type State,
} from "../support/data/reconcile-reference";
import {
  draftRow,
  effectRow,
  headerOf,
  versionRow,
} from "../support/data/rows";
import { Rng } from "../support/data/sync-pages";

/**
 * R6 (revision 6): the reconciliation of a delta page in WINDOWS gives the result of the whole-population function, always.
 *
 * `reconcilePage` (the reference: every effect, version and owning draft in hand at once) is the semantics. The page-commit plan
 * does the same work a window at a time (`plans/reconcile-windows.ts`), each window's writes made before the next is read, with
 * what a window cannot see supplied by indexed questions (does another effect of this draft still show an overlay; does an
 * outstanding draft still target this resource). This holds the two to the same final rows over random queues and pages, at window
 * sizes from one row to the production size, on a final page (the live edge) and on one that is not, with the owner draft present
 * or missing, effects of one draft spread over many windows, and many drafts on one resource.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);

const STATUSES = [
  "queued",
  "in_flight",
  "acknowledged",
  "acknowledged",
  "acknowledged",
  "version_conflict",
  "operation_conflict",
  "blocked",
  "rejected",
] as const;

/** A random queue: resources named by hex (so their key order is not their creation order), drafts, effects and versions. */
function randomState(
  rng: Rng,
  shape: { resources: number; drafts: number },
): State {
  const resources = Array.from(
    { length: shape.resources },
    () => `r-${rng.int(0xffffff).toString(16)}-${rng.int(1000)}`,
  );
  const unique = [...new Set(resources)];
  const drafts: DraftWithCommand[] = Array.from(
    { length: shape.drafts },
    (_, index) =>
      draftRow({
        local_id: `d-${rng.int(0xffff).toString(16)}-${index}`,
        status: rng.pick(STATUSES),
        held_pending_cache: rng.bool(0.4),
        unavailable_outcome: rng.bool(0.1),
        index_targets: unique.filter(() => rng.bool(0.25)),
        created_seq: index + 1,
      }),
  );
  const effects = new Map<string, PendingEffectRow>();
  const effectCount = rng.int(unique.length * 3 + 1);
  for (let i = 0; i < effectCount; i += 1) {
    const resource = rng.pick(unique);
    // Most owners exist; some are gone (the header is missing).
    const owner = rng.bool(0.9)
      ? (rng.pick(drafts) as DraftWithCommand).local_id
      : `gone-${rng.int(5)}`;
    const row = effectRow({
      resource_id: resource,
      local_id: owner,
      display: rng.bool(0.6) ? { label: `shown-${i}` } : null,
      no_publication_floor: rng.bool(0.5) ? rng.int(8) : null,
      resolved: rng.bool(0.15) ? "no_publication" : null,
      last_mentioned_page_seq: rng.bool(0.2) ? rng.int(5) : null,
    });
    effects.set(JSON.stringify([row.resource_id, row.local_id]), row);
  }
  const versions = unique
    .filter(() => rng.bool(0.6))
    .map((resource) =>
      versionRow({
        resource_id: resource,
        locally_assumed_version: rng.int(6) + 1,
        basis: rng.pick([
          "resource",
          "resource",
          "progress_stream",
          "timer_session",
        ] as const),
      }),
    );
  return { effects: [...effects.values()], versions, drafts };
}

function randomPage(rng: Rng, state: State) {
  const known = new Set([
    ...state.effects.map((e) => e.resource_id),
    ...state.versions.map((v) => v.resource_id),
  ]);
  const mentions = new Map<string, Mention>();
  for (const id of known)
    if (rng.bool(0.5))
      mentions.set(
        id,
        rng.bool(0.2)
          ? { removed: true, version: null }
          : { removed: false, version: rng.int(8) + 1 },
      );
  // Ids with no local work at all: the page names them, and nothing of the queue is theirs.
  for (let i = 0; i < 3; i += 1)
    if (rng.bool(0.5))
      mentions.set(`unrelated-${rng.int(100)}`, {
        removed: false,
        version: 1,
      });
  const facts: PageFacts = {
    pageSeq: rng.int(6) + 1,
    hasMore: rng.bool(0.4),
    requestSeq: rng.bool(0.85) ? rng.int(10) : null,
  };
  return { mentions, facts };
}

async function runWindowed(
  state: State,
  mentions: ReadonlyMap<string, Mention>,
  facts: PageFacts,
  window: number,
) {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  env.idb.seed(NAME, "drafts", state.drafts as never);
  env.idb.seed(NAME, "pending_effects", state.effects as never);
  env.idb.seed(NAME, "resource_versions", state.versions as never);
  const plan: Plan<null, null, Reconciled["stats"]> = {
    name: "test.reconcileWindows",
    scope: ["pending_effects", "resource_versions", "drafts", "draft_commands"],
    mode: "readwrite",
    durability: "default",
    read: async () => null,
    decide: () => ({
      writes: [],
      result: {
        mentioned: 0,
        resolvedNoPublication: 0,
        heldReleased: 0,
        unavailable: 0,
      },
    }),
    apply: async (sink, _decision, _reads, _input, reader) =>
      reconcileInWindows({
        reader,
        sink,
        mentions,
        facts,
        walkAllEffects: !facts.hasMore && facts.requestSeq !== null,
        window,
      }),
  };
  const stats = await opened.store.run(plan, null);
  const snapshot = env.idb.snapshot(NAME) as Record<string, object[]>;
  return {
    stats,
    reads: env.idb.reads,
    final: {
      effects: byKey(snapshot.pending_effects as PendingEffectRow[], (e) =>
        JSON.stringify([e.resource_id, e.local_id]),
      ),
      drafts: byKey(snapshot.drafts as DraftRow[], (d) => d.local_id),
      bodies: (snapshot.draft_commands as Array<{ local_id: string }>)
        .map((b) => b.local_id)
        .sort(),
      versions: byKey(
        snapshot.resource_versions as ResourceVersionRow[],
        (v) => v.resource_id,
      ),
    },
  };
}

describe("windowed reconciliation equals the whole-population function", () => {
  const WINDOWS = [1, 2, 3, 7, 100];

  test("over random queues and pages, at every window size, on final and non-final pages", async () => {
    let finalPages = 0;
    let withDeletes = 0;
    let withOthers = 0;
    for (let seed = 1; seed <= 90; seed += 1) {
      const rng = new Rng(seed * 7919);
      const state = randomState(rng, {
        resources: 3 + rng.int(10),
        drafts: 2 + rng.int(8),
      });
      const { mentions, facts } = randomPage(rng, state);
      const reference = reconcilePage({
        effects: byKey(state.effects, (e) =>
          JSON.stringify([e.resource_id, e.local_id]),
        ),
        versions: state.versions,
        drafts: state.drafts.map(headerOf),
        mentions,
        facts,
      });
      const want = expected(state, reference);
      if (!facts.hasMore && facts.requestSeq !== null) finalPages += 1;
      if (reference.draftDeletes.length > 0) withDeletes += 1;
      if (
        reference.effectPuts.length + reference.effectDeletes.length > 0 &&
        state.effects.some((e) =>
          state.effects.some(
            (o) => o !== e && o.local_id === e.local_id && o.display !== null,
          ),
        )
      )
        withOthers += 1;
      for (const window of WINDOWS) {
        const got = await runWindowed(state, mentions, facts, window);
        expect(got.final, `seed ${seed}, window ${window}`).toEqual(want);
        expect(got.stats, `seed ${seed}, window ${window}`).toEqual(
          reference.stats,
        );
        // What was in hand at once is a window, whatever the queue.
        for (const [store, most] of got.reads.maxBatch)
          if (
            ["pending_effects", "resource_versions", "drafts"].includes(store)
          )
            expect(
              most,
              `seed ${seed}, window ${window}, ${store}`,
            ).toBeLessThanOrEqual(Math.max(window, 1));
      }
    }
    // The generator reaches the interesting cases: the live edge, drafts that leave, drafts with several effects.
    expect(finalPages).toBeGreaterThan(20);
    expect(withDeletes).toBeGreaterThan(10);
    expect(withOthers).toBeGreaterThan(10);
  }, 120_000);

  test("a draft whose effects are spread over many windows leaves only when its LAST overlay clears, and not before", async () => {
    // One acknowledged draft with five effects on five resources; the page names the first three; the other two still show.
    const owner = draftRow({
      local_id: "d-owner",
      status: "acknowledged",
      held_pending_cache: false,
      unavailable_outcome: false,
    });
    const effects = ["r-a", "r-b", "r-c", "r-d", "r-e"].map((id) =>
      effectRow({
        resource_id: id,
        local_id: "d-owner",
        display: { label: id },
        no_publication_floor: null,
      }),
    );
    const state: State = { effects, versions: [], drafts: [owner] };
    const mentions = new Map<string, Mention>(
      ["r-a", "r-b", "r-c"].map((id) => [id, { removed: false, version: 1 }]),
    );
    const facts: PageFacts = { pageSeq: 3, hasMore: true, requestSeq: 4 };
    const want = expected(
      state,
      reconcilePage({
        effects,
        versions: [],
        drafts: [headerOf(owner)],
        mentions,
        facts,
      }),
    );
    for (const window of [1, 2, 5]) {
      const got = await runWindowed(state, mentions, facts, window);
      expect(got.final, `window ${window}`).toEqual(want);
      // The draft stays, with its two untouched overlays, and the three mentioned rows are gone.
      expect(got.final.drafts.map((d) => d.local_id)).toEqual(["d-owner"]);
      expect(got.final.effects.map((e) => e.resource_id)).toEqual([
        "r-d",
        "r-e",
      ]);
    }
    // When the page names all five, the draft leaves, with its body.
    const everything = new Map<string, Mention>(
      ["r-a", "r-b", "r-c", "r-d", "r-e"].map((id) => [
        id,
        { removed: false, version: 1 },
      ]),
    );
    for (const window of [1, 2, 5]) {
      const got = await runWindowed(state, everything, facts, window);
      expect(got.final.drafts, `window ${window}`).toEqual([]);
      expect(got.final.bodies).toEqual([]);
      expect(got.final.effects).toEqual([]);
    }
  });

  test("many drafts on ONE resource: a tracked version stays while ANY of them is outstanding, found a window of headers at a time", async () => {
    // 250 settled drafts and one outstanding one, the outstanding one last in key order.
    const settled = Array.from({ length: 250 }, (_, i) =>
      draftRow({
        local_id: `d-${String(i).padStart(4, "0")}`,
        status: "acknowledged",
        index_targets: ["r-shared"],
        created_seq: i + 1,
      }),
    );
    const standing = draftRow({
      local_id: "d-9999",
      status: "queued",
      index_targets: ["r-shared"],
      created_seq: 251,
    });
    const state: State = {
      effects: [],
      versions: [
        versionRow({ resource_id: "r-shared", locally_assumed_version: 2 }),
      ],
      drafts: [...settled, standing],
    };
    const mentions = new Map<string, Mention>([
      ["r-shared", { removed: false, version: 5 }],
    ]);
    const facts: PageFacts = { pageSeq: 1, hasMore: false, requestSeq: 1 };
    for (const window of [1, 10, 100]) {
      const got = await runWindowed(state, mentions, facts, window);
      // Outstanding: the version is NOT deleted; it follows the server (higher).
      expect(got.final.versions).toEqual([
        versionRow({ resource_id: "r-shared", locally_assumed_version: 5 }),
      ]);
      for (const [store, most] of got.reads.maxBatch)
        if (store === "drafts") expect(most).toBeLessThanOrEqual(window);
    }
    // And with no outstanding draft at all it goes.
    const none: State = { ...state, drafts: settled };
    const gone = await runWindowed(none, mentions, facts, 10);
    expect(gone.final.versions).toEqual([]);
    expect([...OUTSTANDING].sort()).toContain("queued");
  });
});

describe("the lookup of the ids that have local work is bounded too (R6, revision 7)", () => {
  /** `interestingOf` over a seeded database, with what each read returned. */
  async function lookup(state: State, ids: readonly string[], window: number) {
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = ACCOUNT;
    const opened = await page.open(ACCOUNT, { create: true });
    if (opened.kind !== "opened") throw new Error("setup");
    env.idb.seed(NAME, "drafts", state.drafts as never);
    env.idb.seed(NAME, "pending_effects", state.effects as never);
    env.idb.seed(NAME, "resource_versions", state.versions as never);
    env.idb.reads.reset();
    const plan: Plan<null, null, string[]> = {
      name: "test.interesting",
      scope: ["pending_effects", "resource_versions"],
      // `apply` (which is handed the reader) belongs to a readwrite plan; it writes nothing.
      mode: "readwrite",
      durability: "default",
      read: async () => null,
      decide: () => ({ writes: [], result: [] }),
      apply: async (_sink, _decision, _reads, _input, reader) =>
        [...(await interestingOf(reader, ids, window))].sort(),
    };
    const found = await opened.store.run(plan, null);
    return { found, reads: env.idb.reads };
  }

  const withWork = (state: State, ids: readonly string[]): string[] => {
    const known = new Set([
      ...state.effects.map((e) => e.resource_id),
      ...state.versions.map((v) => v.resource_id),
    ]);
    return ids.filter((id) => known.has(id)).sort();
  };

  const effectsOf = (resource: string, count: number): PendingEffectRow[] =>
    Array.from({ length: count }, (_, i) =>
      effectRow({
        resource_id: resource,
        local_id: `d-${resource}-${String(i).padStart(4, "0")}`,
        display: { label: `shown ${i}` },
      }),
    );

  test("the reviewer's population: 350 receipt effects on ONE resource, then a lookup naming it: no read returns more than the working set", async () => {
    const state: State = {
      effects: effectsOf("r-fan", 350),
      versions: [],
      drafts: [],
    };
    for (const window of [100, 10, 1]) {
      const got = await lookup(state, ["r-fan"], window);
      expect(got.found, `window ${window}`).toEqual(["r-fan"]);
      expect(
        got.reads.maxBatch.get("pending_effects") ?? 0,
        `window ${window}`,
      ).toBeLessThanOrEqual(window);
      // An existence question: one row was enough to answer it.
      expect(got.reads.rows.get("pending_effects") ?? 0).toBe(1);
    }
  });

  test("simply limiting the combined result would MISS the ids behind the heavy one: they are all found", async () => {
    // `r-a` has 350 effects and sorts first; `r-b` and `r-c` have one each and sort after it.
    const state: State = {
      effects: [
        ...effectsOf("r-a", 350),
        ...effectsOf("r-b", 1),
        ...effectsOf("r-c", 1),
      ],
      versions: [],
      drafts: [],
    };
    for (const window of [100, 2, 1]) {
      const got = await lookup(state, ["r-a", "r-b", "r-c", "r-none"], window);
      expect(got.found, `window ${window}`).toEqual(["r-a", "r-b", "r-c"]);
      expect(
        got.reads.maxBatch.get("pending_effects") ?? 0,
        `window ${window}`,
      ).toBeLessThanOrEqual(window);
    }
  });

  test("every id heavier than the window: the traversal still ends, finds them all, and stays within the window", async () => {
    const ids = ["r-1", "r-2", "r-3", "r-4", "r-5"];
    const state: State = {
      effects: ids.flatMap((id) => effectsOf(id, 10)),
      versions: [],
      drafts: [],
    };
    for (const window of [1, 3, 4]) {
      const got = await lookup(state, ids, window);
      expect(got.found, `window ${window}`).toEqual(ids);
      expect(
        got.reads.maxBatch.get("pending_effects") ?? 0,
        `window ${window}`,
      ).toBeLessThanOrEqual(window);
    }
  });

  test("an id with a tracked version is found without asking about its effects", async () => {
    const state: State = {
      effects: effectsOf("r-ver", 350),
      versions: [versionRow({ resource_id: "r-ver" })],
      drafts: [],
    };
    const got = await lookup(state, ["r-ver"], 100);
    expect(got.found).toEqual(["r-ver"]);
    expect(got.reads.rows.get("pending_effects") ?? 0).toBe(0);
  });

  test("over random queues with heavy resources, at every window: exactly the ids that have local work, and no read above the window", async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rng = new Rng(seed * 104729);
      const state = randomState(rng, {
        resources: 3 + rng.int(10),
        drafts: 2 + rng.int(8),
      });
      // Skew: one or two resources get far more effects than most windows hold.
      const resources = [...new Set(state.effects.map((e) => e.resource_id))];
      const extra = new Map(
        state.effects.map((e) => [
          JSON.stringify([e.resource_id, e.local_id]),
          e,
        ]),
      );
      for (const resource of resources.slice(0, 2))
        for (const row of effectsOf(resource, 5 + rng.int(60)))
          extra.set(JSON.stringify([row.resource_id, row.local_id]), row);
      state.effects = [...extra.values()];
      const known = [
        ...new Set([
          ...state.effects.map((e) => e.resource_id),
          ...state.versions.map((v) => v.resource_id),
        ]),
      ];
      const ids = [
        ...known.filter(() => rng.bool(0.7)),
        ...Array.from({ length: 3 }, (_, i) => `none-${seed}-${i}`),
      ];
      for (const window of [1, 2, 3, 7, 100]) {
        const batch = ids.slice(0, Math.max(window, 1));
        const got = await lookup(state, batch, window);
        expect(got.found, `seed ${seed}, window ${window}`).toEqual(
          withWork(state, batch),
        );
        expect(
          got.reads.maxBatch.get("pending_effects") ?? 0,
          `seed ${seed}, window ${window}`,
        ).toBeLessThanOrEqual(window);
      }
    }
  }, 120_000);
});

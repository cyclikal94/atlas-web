// @vitest-environment node
import { describe, expect, test } from "vitest";
import { candidateEligibility } from "../../src/data/model/dispatch";
import {
  type EnqueueRequest,
  planEnqueue,
  recomputeVersions,
} from "../../src/data/model/outbox";
import { OldestDrafts, TargetFold } from "../../src/data/model/related";
import type {
  CacheRow,
  DraftRow,
  DraftStatus,
  ResourceId,
  SyncStateRow,
} from "../../src/data/model/types";
import { draftRow, headerOf } from "../support/data/rows";
import { Rng } from "../support/data/sync-pages";

/**
 * R21 (revision 9): `TargetFold` stands in for the whole population of drafts that share a target, and the pure decisions give the
 * answer they would have given the population. Held here against the FULL list, over random populations: any statuses, any cut of the
 * population into windows and any order it is read in (the store reads an index in key order, then primary-key order, which is not
 * `created_seq` order). A population is what `planEnqueue`, `recomputeVersions` and `candidateEligibility` used to be handed whole.
 */
const STATUSES: DraftStatus[] = [
  "queued",
  "in_flight",
  "acknowledged",
  "version_conflict",
  "operation_conflict",
  "rejected",
  "superseded",
  "blocked",
];
const IDS = ["a", "b", "c", "d"] as const;

function population(rng: Rng, size: number): DraftRow[] {
  const rows: DraftRow[] = [];
  for (let i = 0; i < size; i += 1) {
    const targets = IDS.filter(() => rng.bool(0.4));
    const bumped = targets.filter(() => rng.bool(0.6));
    rows.push(
      headerOf(
        draftRow({
          local_id: `d${String(i).padStart(4, "0")}`,
          // Unique at rest, and unrelated to the order the rows are read in.
          created_seq: i * 3 + 1 + rng.int(3),
          status: rng.pick(STATUSES),
          index_targets: targets.length ? targets : ["a"],
          bumped,
          bases: Object.fromEntries(
            bumped.map((id) => [id, rng.int(20)] as const),
          ),
          depends_on: [],
        }),
      ),
    );
  }
  return rows;
}

const shuffled = <T>(rng: Rng, items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

/** What `readTouched` hands the pure decisions: the folds of the ids, each fed the rows that name it, in any order. */
function reduce(
  rng: Rng,
  rows: readonly DraftRow[],
  ids: readonly ResourceId[],
  exclude: ReadonlySet<string> = new Set(),
): { others: DraftRow[]; folds: Map<ResourceId, TargetFold> } {
  const folds = new Map<ResourceId, TargetFold>();
  const others = new Map<string, DraftRow>();
  for (const id of ids) {
    const fold = new TargetFold(id);
    for (const row of shuffled(rng, rows))
      if (row.index_targets.includes(id) && !exclude.has(row.local_id))
        fold.add(row);
    folds.set(id, fold);
    for (const row of fold.rows()) others.set(row.local_id, row);
  }
  return { others: [...others.values()], folds };
}

const sync = (): SyncStateRow =>
  ({ draft_seq: 10_000, draft_fence: null }) as unknown as SyncStateRow;
const request = (ids: readonly string[]): EnqueueRequest => ({
  endpoint: "/commands",
  targets: ids.map((resourceId) => ({
    resourceId,
    role: "primary" as const,
    basis: "resource" as const,
    versionChecked: false,
    seedIfUntracked: 1,
  })),
  build: () => ({ command: { kind: "x" } }),
});

describe("TargetFold stands in for the population", () => {
  test("it keeps at most three rows however many it is fed", () => {
    const rows = population(new Rng(1), 600);
    const fold = new TargetFold("a");
    for (const row of rows) if (row.index_targets.includes("a")) fold.add(row);
    expect(fold.rows().length).toBeLessThanOrEqual(2);
    expect(
      [fold.latest, fold.earliest, fold.floor].filter((row) => row).length,
    ).toBeLessThanOrEqual(3);
  });

  test("a new draft waits on the same drafts (planEnqueue), for 300 random populations", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = new Rng(seed);
      const rows = population(rng, 1 + rng.int(40));
      const ids = IDS.filter(() => rng.bool(0.6));
      const targets = ids.length ? ids : ["a"];
      const facts = (related: readonly DraftRow[]) => ({
        sync: sync(),
        cache: new Map<string, CacheRow>(),
        versions: new Map(),
        related,
        existing: undefined,
        localId: "new",
        accountId: "acct",
        now: "2026-10-01T09:00:00.000Z",
      });
      const whole = planEnqueue(request(targets), facts(rows));
      const reduced = planEnqueue(
        request(targets),
        facts(reduce(rng, rows, targets).others),
      );
      if (whole.kind !== "queued" || reduced.kind !== "queued")
        throw new Error(`seed ${seed}: ${whole.kind}/${reduced.kind}`);
      expect(reduced.draft.depends_on, `seed ${seed}`).toEqual(
        whole.draft.depends_on,
      );
    }
  });

  test("the version base is recomputed the same (recomputeVersions), for 300 random populations", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = new Rng(seed * 7);
      const rows = population(rng, 2 + rng.int(40));
      const members = rows.slice(0, 1 + rng.int(3));
      const gone = new Set(members.map((row) => row.local_id));
      const rest = rows.filter((row) => !gone.has(row.local_id));
      const touched = [
        ...new Set(members.flatMap((m) => [...m.index_targets, ...m.bumped])),
      ];
      const cache = new Map<string, CacheRow>(
        touched
          .filter(() => rng.bool(0.5))
          .map((id) => [id, { id, version: rng.int(25) } as CacheRow]),
      );
      const versions = new Map(
        touched
          .filter(() => rng.bool(0.5))
          .map((id) => [
            id,
            {
              resource_id: id,
              locally_assumed_version: rng.int(25),
              basis: "resource" as const,
            },
          ]),
      );
      const whole = recomputeVersions({
        members,
        others: rest.filter((row) =>
          row.index_targets.some((id) => touched.includes(id)),
        ),
        cache,
        versions,
      });
      const reduced = recomputeVersions({
        members,
        others: reduce(rng, rest, touched, gone).others,
        cache,
        versions,
      });
      expect(reduced, `seed ${seed}`).toEqual(whole);
    }
  });

  test("a candidate is held back by its target exactly when an earlier unsettled draft shares it (candidateEligibility), for 300 random populations", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = new Rng(seed * 13);
      const rows = population(rng, 2 + rng.int(40));
      const context = { now: 1_000, holdFrom: null };
      for (const row of rows) {
        if (row.status !== "queued" && row.status !== "in_flight") continue;
        const { folds } = reduce(rng, rows, row.index_targets);
        const earliest = [...folds.values()].flatMap((fold) =>
          fold.earliest ? [fold.earliest] : [],
        );
        expect(
          candidateEligibility(row, context, {
            dependencies: new Map(),
            sharing: earliest,
          }).verdict,
          `seed ${seed} ${row.local_id}`,
        ).toBe(
          candidateEligibility(row, context, {
            dependencies: new Map(),
            sharing: rows,
          }).verdict,
        );
      }
    }
  });

  test("a settled draft is never the earliest, the latest or the floor", () => {
    const fold = new TargetFold("a");
    for (const [i, status] of (
      ["acknowledged", "rejected", "superseded"] as DraftStatus[]
    ).entries())
      fold.add(
        headerOf(
          draftRow({
            local_id: `s${i}`,
            created_seq: i + 1,
            status,
            index_targets: ["a"],
            bumped: ["a"],
            bases: { a: 9 },
          }),
        ),
      );
    expect(fold.rows()).toEqual([]);
    expect(fold.earliest).toBeUndefined();
  });
});

describe("OldestDrafts: the oldest window of a population, and its exact size (R21, revision 10)", () => {
  const ids = (rows: readonly DraftRow[]) => rows.map((row) => row.local_id);

  test("it keeps at most `size` headers however many it is fed, and counts every one", () => {
    const rows = population(new Rng(3), 900);
    const fold = new OldestDrafts(100);
    for (const row of rows) fold.add(row);
    expect(fold.rows()).toHaveLength(100);
    expect(fold.total).toBe(900);
  });

  test("its windows, passed back as the cursor, meet every header exactly once in `created_seq` order, for 300 random populations", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = new Rng(seed * 17);
      const rows = population(rng, rng.int(60));
      const size = 1 + rng.int(12);
      const whole = [...rows].sort((a, b) => a.created_seq - b.created_seq);
      const seen: DraftRow[] = [];
      let after: number | null = null;
      for (let page = 0; page < 100; page += 1) {
        const fold: OldestDrafts = new OldestDrafts(size, after);
        // The store reads in key order, not `created_seq` order, in any windows: the order it is fed in must not matter.
        for (const row of shuffled(rng, rows)) fold.add(row);
        expect(fold.total, `seed ${seed}`).toBe(rows.length);
        expect(fold.rows().length, `seed ${seed}`).toBeLessThanOrEqual(size);
        seen.push(...fold.rows());
        after = fold.next;
        if (after === null) break;
      }
      expect(ids(seen), `seed ${seed}`).toEqual(ids(whole));
    }
  });

  test("the last window has no cursor, and a window that exactly fills the population has none either", () => {
    const rows = population(new Rng(5), 10);
    const exact = new OldestDrafts(10);
    for (const row of rows) exact.add(row);
    expect(exact.next).toBeNull();
    const short = new OldestDrafts(9);
    for (const row of rows) short.add(row);
    expect(short.next).not.toBeNull();
    const empty = new OldestDrafts(5);
    expect(empty.rows()).toEqual([]);
    expect(empty.next).toBeNull();
    expect(empty.total).toBe(0);
  });

  test("headers at or before the cursor are counted and skipped, so the size is the whole population's on every window", () => {
    const rows = population(new Rng(8), 30);
    const sorted = [...rows].sort((a, b) => a.created_seq - b.created_seq);
    const cursor = (sorted[9] as DraftRow).created_seq;
    const fold = new OldestDrafts(5, cursor);
    for (const row of rows) fold.add(row);
    expect(fold.total).toBe(30);
    expect(ids(fold.rows())).toEqual(ids(sorted.slice(10, 15)));
    expect(fold.next).toBe((sorted[14] as DraftRow).created_seq);
  });
});

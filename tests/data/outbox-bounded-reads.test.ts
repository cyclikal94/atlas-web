// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { durableNotBefore } from "../../src/data/model/dispatch";
import type { DraftRow } from "../../src/data/model/types";
import {
  admitReceipt,
  readConflicts,
  readDispatchWindow,
  readMerged,
  readQueueSummary,
  recordOutcome,
  resumeDrafts,
} from "../../src/data/plans/outbox";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow, draftRow, headerOf } from "../support/data/rows";
import { Rng } from "../support/data/sync-pages";

/**
 * R21 (revision 9): the outbox's related reads are bounded by a WINDOW, whatever the population they ask about. The reviewer's
 * probes: one conflict and 500 queued drafts sharing its target (first dispatch window), 501 paused, 501 awaiting a defaults review,
 * an enqueue against a target with 501 drafts, a discard with a 501-member related population. Each used to read the whole
 * population in one call (501 rows) and, for the dispatcher, once per candidate (50,200 rows in all).
 *
 * "Bounded" is what the double of IndexedDB counts (`idb.reads`): the most rows ONE read call returned, and the rows read in all.
 * FIXTURE evidence: it is not a measurement of a real engine's memory. Every bound is asserted beside a CONTROL of the same shape at
 * a small size (the semantics are unchanged), and the atomic writes beside a rollback.
 */
const WINDOW = DATA_CONFIG.queueWorkingSet;
const N = 501;
type World = Awaited<ReturnType<typeof outboxWorld>>;

const reads = (w: World, store = "drafts") => ({
  max: w.env.idb.reads.maxBatch.get(store) ?? 0,
  rows: w.env.idb.reads.rows.get(store) ?? 0,
});

const seedRows = (w: World, rows: ReturnType<typeof draftRow>[]) => {
  w.put("drafts", rows);
  w.setSync({ draft_seq: Math.max(0, ...rows.map((row) => row.created_seq)) });
};

const dispatch = (w: World, over: Record<string, unknown> = {}) =>
  w.service.store.run(readDispatchWindow, {
    incarnationId: w.service.incarnationId,
    now: Date.now(),
    blockedUntil: new Map(),
    windowSize: WINDOW,
    ...over,
  });

/** `count` drafts that share one target, the first of them `first`, the rest `queued`, each depending on the first when asked. */
const sharing = (
  count: number,
  first: Partial<DraftRow> = { status: "version_conflict" },
  dependOnFirst = false,
) =>
  Array.from({ length: count }, (_, i) =>
    draftRow({
      local_id: `d${i}`,
      created_seq: i + 1,
      index_targets: ["hot"],
      target_resource_ids: ["hot"],
      depends_on: dependOnFirst && i > 0 ? ["d0"] : [],
      ...(i === 0 ? first : {}),
    } as never),
  );

describe("the dispatcher's read", () => {
  test("a blocked target shared by 500 queued drafts: nothing is read more than a window at a time, and the target is read ONCE", async () => {
    const w = await outboxWorld();
    seedRows(w, sharing(N));
    w.env.idb.reads.reset();
    const result = await dispatch(w);
    // The conflict at the head holds every draft that shares its target: no pick, however many are examined.
    expect(result.pick).toBeNull();
    expect(result.blocked).toBe(WINDOW);
    // The window ends at the 100th queued draft behind the conflict (created_seq 101): the dispatcher continues from there.
    expect(result.next).toBe(WINDOW + 1);
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    // The population of the target is walked once for the whole window (not once per candidate: 50,200 rows before).
    expect(reads(w).rows).toBeLessThanOrEqual(N + 3 * WINDOW);
  });

  test("control: the same shape at five drafts decides the same way", async () => {
    const w = await outboxWorld();
    seedRows(w, sharing(5));
    const result = await dispatch(w);
    expect(result.pick).toBeNull();
    expect(result.blocked).toBe(4);
    expect(result.next).toBeNull();
  });

  test("a head that is NOT blocked is sent and nothing behind it moves: the earliest draft of a shared target goes first (FIFO)", async () => {
    const w = await outboxWorld();
    seedRows(w, sharing(N, { status: "queued" }));
    w.env.idb.reads.reset();
    const result = await dispatch(w);
    expect(result.pick?.local_id).toBe("d0");
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test.each([
    ["paused", { retry_state: { state: "paused" as const, since: 1 } }],
    [
      "awaiting a defaults review",
      { review_block: { kind: "defaults" as const, kinds: ["a"] } },
    ],
  ])(
    "501 drafts %s: counted exactly, a window at a time, with no pick",
    async (_name, over) => {
      const w = await outboxWorld();
      seedRows(
        w,
        Array.from({ length: N }, (_, i) =>
          draftRow({
            local_id: `p${i}`,
            created_seq: i + 1,
            index_targets: [`r${i}`],
            target_resource_ids: [`r${i}`],
            ...over,
          } as never),
        ),
      );
      w.env.idb.reads.reset();
      const result = await dispatch(w);
      expect(result.pick).toBeNull();
      expect(result.selection.paused).toBe(N);
      expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
      expect(reads(w).rows).toBeLessThanOrEqual(N + 3 * WINDOW);
    },
  );

  test("a defaults review holds the queue behind it: holdFrom is the lowest created_seq of the reviewing drafts of 501", async () => {
    const w = await outboxWorld();
    seedRows(
      w,
      Array.from({ length: N }, (_, i) =>
        draftRow({
          local_id: `p${i}`,
          created_seq: i + 10,
          index_targets: [`r${i}`],
          target_resource_ids: [`r${i}`],
          review_block: i % 2 === 0 ? { kind: "defaults", kinds: ["a"] } : null,
        } as never),
      ),
    );
    const result = await dispatch(w);
    expect(result.selection.holdFrom).toBe(10);
    // 251 reviewing drafts need the person; the rest are held behind the first of them.
    expect(result.selection.paused).toBe(251);
    expect(result.pick).toBeNull();
  });

  test("backing-off drafts: the count and the next wake are exact over 501, a window at a time", async () => {
    const w = await outboxWorld();
    const now = Date.parse("2026-10-01T10:00:00.000Z");
    const rows = Array.from({ length: N }, (_, i) =>
      draftRow({
        local_id: `b${i}`,
        created_seq: i + 1,
        status: "in_flight",
        index_targets: [`r${i}`],
        target_resource_ids: [`r${i}`],
        retry_state: { state: "backing_off", since: now - 1_000 },
        attempts: 1 + (i % 4),
        last_attempt_at: new Date(now - 500 - i).toISOString(),
      } as never),
    );
    seedRows(w, rows);
    const expected = rows
      .map((row) => durableNotBefore(row))
      .filter((at) => at > now);
    w.env.idb.reads.reset();
    const result = await dispatch(w, { now });
    expect(result.selection.backingOff).toBe(expected.length);
    expect(result.selection.wakeAt).toBe(Math.min(...expected));
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("the aggregates equal the reference over random queues of mixed statuses and retry states", async () => {
    for (let seedNo = 1; seedNo <= 25; seedNo += 1) {
      const rng = new Rng(seedNo);
      const w = await outboxWorld();
      const now = Date.parse("2026-10-01T10:00:00.000Z");
      const rows = Array.from({ length: 40 + rng.int(220) }, (_, i) =>
        draftRow({
          local_id: `m${String(i).padStart(4, "0")}`,
          created_seq: i + 1,
          status: rng.pick([
            "queued",
            "in_flight",
            "version_conflict",
            "rejected",
          ] as const),
          index_targets: [`t${rng.int(30)}`],
          target_resource_ids: [`t${rng.int(30)}`],
          review_block: rng.bool(0.1)
            ? { kind: "defaults", kinds: ["a"] }
            : null,
          retry_state: rng.bool(0.3)
            ? { state: rng.pick(["paused", "backing_off"] as const), since: 1 }
            : null,
          attempts: rng.int(5),
          last_attempt_at: new Date(now - rng.int(4_000)).toISOString(),
        } as never),
      );
      seedRows(w, rows);
      const sendable = (r: DraftRow) =>
        r.status === "queued" || r.status === "in_flight";
      const reviewing = rows.filter(
        (r) => r.review_block !== null && sendable(r),
      );
      const needs = new Set(reviewing.map((r) => r.local_id));
      for (const r of rows)
        if (r.retry_state?.state === "paused" && sendable(r))
          needs.add(r.local_id);
      // Some drafts are held apart by the dispatcher itself (a `Retry-After`, a stop): the finite instants count and set the wake, an
      // infinite one is left alone until the person asks (counted, but it sets no wake).
      const blockedUntil = new Map<string, number>();
      for (const r of rows)
        if (rng.bool(0.15))
          blockedUntil.set(
            r.local_id,
            rng.bool(0.3) ? Number.POSITIVE_INFINITY : now + rng.int(10_000),
          );
      let backing = 0;
      let wake: number | null = null;
      for (const r of rows)
        if (
          r.retry_state?.state === "backing_off" &&
          sendable(r) &&
          r.review_block === null
        ) {
          const at = blockedUntil.get(r.local_id) ?? durableNotBefore(r);
          if (at > now) {
            backing += 1;
            if (Number.isFinite(at))
              wake = wake === null ? at : Math.min(wake, at);
          }
        }
      const got = await dispatch(w, { now, blockedUntil });
      expect(got.selection.paused, `seed ${seedNo}`).toBe(needs.size);
      expect(got.selection.backingOff, `seed ${seedNo}`).toBe(backing);
      expect(got.selection.wakeAt, `seed ${seedNo}`).toBe(wake);
      expect(got.selection.holdFrom, `seed ${seedNo}`).toBe(
        reviewing.length === 0
          ? null
          : Math.min(...reviewing.map((r) => r.created_seq)),
      );
    }
  });
});

describe("enqueue and the cascades", () => {
  const put = async (
    w: World,
    count: number,
    first?: Partial<DraftRow>,
    chain = false,
  ) => {
    w.put("cache", [cacheRow({ id: "hot", version: 1 })]);
    seedRows(w, sharing(count, first, chain));
    w.env.idb.reads.reset();
  };

  test("enqueue against a target with 501 drafts: saved, depending on the LAST unsettled one, reading a window at a time", async () => {
    const w = await outboxWorld();
    await put(w, N, { status: "queued" });
    const out = await w.outbox.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: "hot",
          role: "primary",
          basis: "resource",
          versionChecked: true,
        },
      ],
      build: (bases) => ({
        command: { kind: "edit", base: bases.hot as number },
      }),
    });
    expect(out.kind).toBe("queued");
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    const created = w.drafts().find((d) => d.created_seq === N + 1);
    expect(created?.depends_on).toEqual([`d${N - 1}`]);
  });

  test("control: five drafts, the same dependency", async () => {
    const w = await outboxWorld();
    await put(w, 5, { status: "queued" });
    const out = await w.outbox.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: "hot",
          role: "primary",
          basis: "resource",
          versionChecked: true,
        },
      ],
      build: (bases) => ({
        command: { kind: "edit", base: bases.hot as number },
      }),
    });
    expect(out.kind).toBe("queued");
    expect(w.drafts().find((d) => d.created_seq === 6)?.depends_on).toEqual([
      "d4",
    ]);
  });

  test("discard of the root of 500 dependants that share its target: every dependant is rejected, atomically, reading a window at a time", async () => {
    const w = await outboxWorld();
    await put(w, N, { status: "queued" }, true);
    const out = await w.outbox.discard("d0");
    expect(out).toMatchObject({
      kind: "discarded",
      outcome: "removed",
      affected: N - 1,
    });
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    expect(reads(w, "pending_effects").max).toBeLessThanOrEqual(WINDOW);
    expect(w.drafts().map((d) => d.status)).toEqual(
      Array.from({ length: N - 1 }, () => "rejected"),
    );
    expect(w.drafts().find((d) => d.local_id === "d0")).toBeUndefined();
  });

  test("control: the same discard at five drafts", async () => {
    const w = await outboxWorld();
    await put(w, 5, { status: "queued" }, true);
    expect(await w.outbox.discard("d0")).toMatchObject({
      kind: "discarded",
      affected: 4,
    });
    expect(w.drafts().map((d) => d.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });

  test("a discard that fails part-way leaves everything exactly as it was (rollback)", async () => {
    const w = await outboxWorld();
    await put(w, N, { status: "queued" }, true);
    const before = JSON.stringify(w.drafts());
    const off = w.env.idb.inject({
      match: (tx) => tx.label === "data.discardDraft",
      mode: { kind: "throw_on_write", n: 2, as: "error" },
    });
    await expect(w.outbox.discard("d0")).resolves.toMatchObject({});
    off();
    expect(JSON.stringify(w.drafts())).toBe(before);
  });

  test("a discard reaches the version base the same with a hot target as without (recompute): the discarded draft's own base is not counted among the drafts that stand", async () => {
    for (const count of [5, N]) {
      const w = await outboxWorld();
      w.put("cache", [cacheRow({ id: "hot", version: 1 })]);
      // The discarded conflict stands on base 50; every other draft stands on base 3, so after the discard the record is 50 (the
      // conflict's own base, the least of the members') and not 51 (as if the conflict itself still stood).
      const rows = sharing(count, { status: "version_conflict" }, false).map(
        (row, i) =>
          draftRow({
            ...row,
            bumped: ["hot"],
            bases: { hot: i === 0 ? 50 : 3 },
            status: i === 0 ? "version_conflict" : "queued",
          } as never),
      );
      seedRows(w, rows);
      w.put("resource_versions", [
        { resource_id: "hot", locally_assumed_version: 52, basis: "resource" },
      ]);
      const out = await w.outbox.discard("d0");
      expect(out.kind).toBe("discarded");
      expect(
        w.versions().find((v) => v.resource_id === "hot")
          ?.locally_assumed_version,
        `count ${count}`,
      ).toBe(50);
    }
  });

  test("supersede of a conflict with 500 drafts behind it reads a window at a time and keeps the order", async () => {
    const w = await outboxWorld();
    await put(w, N, { status: "version_conflict" }, true);
    const out = await w.outbox.supersede("d0", {
      endpoint: "/commands",
      targets: [
        {
          resourceId: "hot",
          role: "primary",
          basis: "resource",
          versionChecked: false,
          seedIfUntracked: 1,
        },
      ],
      build: () => ({ command: { kind: "edit" } }),
    });
    expect(out.kind).toBe("superseded");
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    expect(
      w.drafts().filter((d) => d.status === "version_conflict").length,
    ).toBe(N - 1);
  });
});

describe("the receipt and the outcome", () => {
  test("a receipt for a draft with 500 dependants reads them a window at a time and releases them all", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "hot", version: 1 })]);
    seedRows(
      w,
      sharing(N, { status: "in_flight" }, true).map((row, i) =>
        i === 0 ? row : draftRow({ ...row, status: "queued" } as never),
      ),
    );
    w.env.idb.reads.reset();
    const out = await w.service.commit(admitReceipt, {
      captured: w.capture(),
      localId: "d0",
      revision: 7,
    });
    expect(out.kind).toBe("applied");
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    // Nobody waits on the acknowledged draft any more.
    expect(w.drafts().filter((d) => d.depends_on.includes("d0"))).toEqual([]);
  });

  test("a rejection of a draft with 500 dependants rejects them all, reading a window at a time", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "hot", version: 1 })]);
    seedRows(
      w,
      sharing(N, { status: "in_flight" }, true).map((row, i) =>
        i === 0 ? row : draftRow({ ...row, status: "queued" } as never),
      ),
    );
    w.env.idb.reads.reset();
    const out = await w.service.commit(recordOutcome, {
      captured: w.capture(),
      localId: "d0",
      outcome: { kind: "rejected", status: 422, code: "invalid" } as never,
      error: { stage: "rejected" } as never,
      now: Date.now(),
      nowIso: new Date().toISOString(),
    });
    expect(out.kind).toBe("applied");
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    expect(w.drafts().every((d) => d.status === "rejected")).toBe(true);
    expect(w.drafts()).toHaveLength(N);
  });
});

describe("resume, conflicts, the summary and one resource", () => {
  test("Retry now for 501 retrying drafts resumes every one in ONE transaction, a window at a time, in order", async () => {
    const w = await outboxWorld();
    const rows = Array.from({ length: N + 5 }, (_, i) =>
      draftRow({
        local_id: `r${String(i).padStart(4, "0")}`,
        created_seq: i + 1,
        status: "in_flight",
        index_targets: [`t${i}`],
        retry_state:
          i < N
            ? { state: i % 2 === 0 ? "paused" : "backing_off", since: 1 }
            : null,
        attempts: 3,
      } as never),
    );
    // A draft that is no longer in flight keeps whatever retry state it carries: only the retrying drafts are resumed.
    rows.push(
      draftRow({
        local_id: "stale",
        created_seq: N + 10,
        status: "version_conflict",
        index_targets: ["stale"],
        retry_state: { state: "paused", since: 1 },
      } as never),
    );
    seedRows(w, rows);
    w.env.idb.reads.reset();
    const out = await w.service.store.run(resumeDrafts, {
      incarnationId: w.service.incarnationId,
      localIds: "retrying",
    });
    expect(out.resumed).toHaveLength(N);
    expect(w.drafts().find((d) => d.local_id === "stale")?.retry_state).toEqual(
      { state: "paused", since: 1 },
    );
    expect(out.resumed).toEqual([...out.resumed].sort());
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    expect(
      w
        .drafts()
        .filter((d) => d.retry_state !== null)
        .map((d) => d.local_id),
    ).toEqual(["stale"]);
  });

  test("Retry now for retrying drafts that fails part-way changes nothing (rollback)", async () => {
    const w = await outboxWorld();
    seedRows(
      w,
      Array.from({ length: N }, (_, i) =>
        draftRow({
          local_id: `r${String(i).padStart(4, "0")}`,
          created_seq: i + 1,
          status: "in_flight",
          index_targets: [`t${i}`],
          retry_state: { state: "paused", since: 1 },
        } as never),
      ),
    );
    const before = JSON.stringify(w.drafts());
    w.env.idb.inject({
      match: (tx) => tx.label === "data.resumeDrafts",
      mode: { kind: "throw_on_write", n: 2, as: "error" },
    });
    await expect(
      w.service.store.run(resumeDrafts, {
        incarnationId: w.service.incarnationId,
        localIds: "retrying",
      }),
    ).rejects.toBeDefined();
    expect(JSON.stringify(w.drafts())).toBe(before);
  });

  test("resuming named drafts is unchanged, and an explicit list larger than a window is read a window at a time", async () => {
    const w = await outboxWorld();
    const rows = Array.from({ length: N }, (_, i) =>
      draftRow({
        local_id: `r${String(i).padStart(4, "0")}`,
        created_seq: i + 1,
        status: "in_flight",
        index_targets: [`t${i}`],
        retry_state: { state: "paused", since: 1 },
      } as never),
    );
    seedRows(w, rows);
    w.env.idb.reads.reset();
    const out = await w.service.store.run(resumeDrafts, {
      incarnationId: w.service.incarnationId,
      localIds: rows.map((row) => row.local_id),
    });
    expect(out.resumed).toHaveLength(N);
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("the conflict inbox over 501 defaults reviews shows the OLDEST page and says there is more, a window at a time", async () => {
    const w = await outboxWorld();
    const rng = new Rng(5);
    const order = Array.from({ length: N }, (_, i) => i + 1).sort(
      () => rng.next() - 0.5,
    );
    seedRows(
      w,
      order.map((seq) =>
        draftRow({
          // The ids run against the sequence, so the walk of the index meets the NEWEST review first.
          local_id: `v${String(N + 1 - seq).padStart(4, "0")}`,
          created_seq: seq,
          index_targets: [`t${seq}`],
          review_block: { kind: "defaults", kinds: ["a"] },
        } as never),
      ),
    );
    w.env.idb.reads.reset();
    const page = await w.service.store.run(readConflicts, {
      incarnationId: w.service.incarnationId,
      limit: 20,
    });
    expect(page.more).toBe(true);
    expect(page.rows.map((row) => row.draft.created_seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("the conflict inbox says there is no more when exactly one page exists, and more when one extra does", async () => {
    for (const [count, more] of [
      [20, false],
      [21, true],
    ] as const) {
      const w = await outboxWorld();
      seedRows(
        w,
        Array.from({ length: count }, (_, i) =>
          draftRow({
            local_id: `v${i}`,
            created_seq: i + 1,
            index_targets: [`t${i}`],
            review_block: { kind: "defaults", kinds: ["a"] },
          } as never),
        ),
      );
      const page = await w.service.store.run(readConflicts, {
        incarnationId: w.service.incarnationId,
        limit: 20,
      });
      expect(page.more, `${count}`).toBe(more);
      expect(page.rows).toHaveLength(20);
    }
  });

  test("the summary counts 501 reviewing drafts and 300 held acknowledgements exactly", async () => {
    const w = await outboxWorld();
    const reviewing = Array.from({ length: N }, (_, i) =>
      draftRow({
        local_id: `v${i}`,
        created_seq: i + 1,
        index_targets: [`t${i}`],
        review_block: { kind: "defaults", kinds: ["a"] },
      } as never),
    );
    const held = Array.from({ length: 300 }, (_, i) =>
      draftRow({
        local_id: `h${i}`,
        created_seq: N + i + 1,
        status: "acknowledged",
        index_targets: [`h${i}`],
        held_pending_cache: i % 2 === 0,
        unavailable_outcome: i % 2 === 1 && i % 3 === 0,
      } as never),
    );
    seedRows(w, [...reviewing, ...held]);
    w.env.idb.reads.reset();
    const summary = await w.service.store.run(readQueueSummary, {
      incarnationId: w.service.incarnationId,
    });
    const expectedHeld = held.filter(
      (row) => row.held_pending_cache || row.unavailable_outcome,
    ).length;
    expect(summary).toMatchObject({ held: expectedHeld });
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("one resource that 501 drafts target: nothing is read for the drafts when the cache holds it, and a window at a time when not", async () => {
    const w = await outboxWorld();
    seedRows(w, sharing(N, { status: "queued" }));
    w.put("cache", [cacheRow({ id: "hot", version: 1 })]);
    w.env.idb.reads.reset();
    await w.service.store.run(readMerged, {
      incarnationId: w.service.incarnationId,
      id: "hot",
    });
    expect(reads(w).rows).toBe(0);
    w.env.idb.reads.reset();
    await w.service.store.run(readMerged, {
      incarnationId: w.service.incarnationId,
      id: "absent",
    });
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });
});

describe("R21 (revision 10): a population of stopped drafts, and a new resource with many saved edits", () => {
  const stoppedRows = (count: number, first = 0) =>
    Array.from({ length: count }, (_, i) =>
      draftRow({
        local_id: `d${first + i}`,
        created_seq: first + i + 1,
        index_targets: [`own${first + i}`],
        target_resource_ids: [`own${first + i}`],
        command: { kind: "edit", data: "x".repeat(200) },
      } as never),
    );
  const streaksOf = (ids: string[], prefix = "draft") =>
    Object.fromEntries(ids.map((id) => [`${prefix}:${id}`, 3] as const));

  describe.each([
    ["the durable streaks", "streaks"],
    ["the account's fallback markers", "markers"],
  ] as const)("a stop named by %s", (_name, source) => {
    const seed = (w: World, ids: string[]) => {
      if (source === "streaks")
        w.setSync({ local_write_streaks: streaksOf(ids) });
      return source === "markers"
        ? { markerOperations: ids.map((id) => `draft:${id}`) }
        : {};
    };

    test("501 stopped drafts: every one is named, and no read returns more than a window of them", async () => {
      const w = await outboxWorld();
      const rows = stoppedRows(N);
      seedRows(w, rows);
      const over = seed(
        w,
        rows.map((row) => row.local_id),
      );
      w.env.idb.reads.reset();
      const result = await dispatch(w, over);
      expect(result.pick).toBeNull();
      expect(result.stopped).toHaveLength(N);
      expect(new Set(result.stopped).size).toBe(N);
      expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
      // The stopped drafts are looked up once each (no candidate is read once per stopped draft) and nothing else is read from them.
      expect(reads(w).rows).toBeLessThanOrEqual(N + 4 * WINDOW);
    });

    test("control: five stopped drafts are named the same way, and a draft that is not stopped is still picked", async () => {
      const w = await outboxWorld();
      const rows = stoppedRows(6);
      seedRows(w, rows);
      const over = seed(
        w,
        rows.slice(0, 5).map((row) => row.local_id),
      );
      const result = await dispatch(w, over);
      expect(result.stopped).toEqual(["d0", "d1", "d2", "d3", "d4"]);
      expect(result.pick?.local_id).toBe("d5");
    });

    test("a stop that names a draft that no longer exists names nothing: only the drafts that are there are stopped", async () => {
      const w = await outboxWorld();
      const rows = stoppedRows(300);
      seedRows(w, rows);
      const ids = [
        ...rows.map((row) => row.local_id),
        ...Array.from({ length: 201 }, (_, i) => `gone${i}`),
      ];
      const over = seed(w, ids);
      w.env.idb.reads.reset();
      const result = await dispatch(w, over);
      expect(result.stopped).toHaveLength(300);
      expect(result.stopped.every((id) => id.startsWith("d"))).toBe(true);
      expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    });

    test("a draft behind 501 stopped drafts is reachable: the dispatcher's windows walk past them", async () => {
      const w = await outboxWorld();
      const rows = [...stoppedRows(N), ...stoppedRows(1, N)];
      seedRows(w, rows);
      const over = seed(
        w,
        rows.slice(0, N).map((row) => row.local_id),
      );
      let after: number | undefined;
      let picked: string | null = null;
      let windows = 0;
      w.env.idb.reads.reset();
      while (picked === null && windows < 20) {
        const result = await dispatch(
          w,
          after === undefined ? over : { ...over, after },
        );
        windows += 1;
        picked = result.pick?.local_id ?? null;
        if (result.next === null) break;
        after = result.next;
      }
      expect(picked).toBe(`d${N}`);
      expect(windows).toBe(Math.ceil((N + 1) / WINDOW));
      expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    });
  });

  test("the `receipt:` operations of a draft's own writes stop it the same way", async () => {
    const w = await outboxWorld();
    const rows = stoppedRows(N);
    seedRows(w, rows);
    w.setSync({
      local_write_streaks: streaksOf(
        rows.map((row) => row.local_id),
        "receipt",
      ),
    });
    w.env.idb.reads.reset();
    const result = await dispatch(w);
    expect(result.stopped).toHaveLength(N);
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("the whole dispatcher over 501 stopped drafts: the one draft that is not stopped is sent, and no read exceeds a window", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    const rows = stoppedRows(N);
    seedRows(w, [...rows, ...stoppedRows(1, N)]);
    w.setSync({
      local_write_streaks: streaksOf(rows.map((row) => row.local_id)),
    });
    w.env.idb.reads.reset();
    w.start();
    await w.settle();
    expect(w.sent.map((r) => r.key)).toEqual([`d${N}`]);
    expect(w.dispatcher.state.get()).toMatchObject({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
    // Every stopped draft is still there, unsent and unchanged.
    expect(w.drafts().filter((row) => row.status === "queued")).toHaveLength(N);
    w.dispatcher.stop();
  });

  // ---- a new resource with many saved edits -----------------------------------------------------------------------------------
  const bodies = (w: World) => reads(w, "draft_commands");

  /** One new resource: the create, then `count - 1` saved edits of it, all through the PUBLIC outbox (nothing is seeded). */
  async function saveEdits(w: World, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const saved = await w.outbox.enqueue({
        localId: `new-${String(i).padStart(4, "0")}`,
        endpoint: "/commands",
        targets: [
          {
            resourceId: "new-person",
            role: "primary",
            basis: "resource",
            versionChecked: i !== 0,
            ...(i === 0 ? { seedIfUntracked: 1 } : {}),
          },
        ],
        build: (bases) => ({
          command: {
            kind: i === 0 ? "create_person" : "edit_person",
            id: "new-person",
            expected_version: bases["new-person"] ?? 1,
            data: "x".repeat(1000),
          },
        }),
      });
      expect(saved.kind).toBe("queued");
      if (saved.kind === "queued") ids.push(saved.localId);
    }
    return ids;
  }

  const merged = (w: World, after?: number | null) =>
    w.service.store.run(readMerged, {
      incarnationId: w.service.incarnationId,
      id: "new-person",
      ...(after === undefined ? {} : { after }),
    });

  test("501 saved changes of a new resource: the oldest window is returned with its bodies, the number is exact, and no read returns more than a window", async () => {
    const w = await outboxWorld();
    const ids = await saveEdits(w, N);
    expect(w.rows("cache")).toHaveLength(0);
    w.env.idb.reads.reset();
    const result = await merged(w);
    expect(result.createsTotal).toBe(N);
    expect(result.creates).toHaveLength(WINDOW);
    // Oldest first: the create that introduces the resource is the first of them.
    expect(result.creates.map((draft) => draft.local_id)).toEqual(
      ids.slice(0, WINDOW),
    );
    expect(result.creates[0]?.command).toMatchObject({ kind: "create_person" });
    expect(result.createsNext).toBe(result.creates[WINDOW - 1]?.created_seq);
    expect(bodies(w).max).toBeLessThanOrEqual(WINDOW);
    expect(bodies(w).rows).toBeLessThanOrEqual(WINDOW);
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("control: five saved changes are all returned, with their bodies, and there is no next window", async () => {
    const w = await outboxWorld();
    const ids = await saveEdits(w, 5);
    w.env.idb.reads.reset();
    const result = await merged(w);
    expect(result.creates.map((draft) => draft.local_id)).toEqual(ids);
    expect(result.createsTotal).toBe(5);
    expect(result.createsNext).toBeNull();
    expect(bodies(w).rows).toBe(5);
  });

  test("every saved change is reachable: the windows, passed back as `after`, meet each of the 501 exactly once, in order", async () => {
    const w = await outboxWorld();
    const ids = await saveEdits(w, N);
    const seen: string[] = [];
    let after: number | null | undefined;
    let pages = 0;
    w.env.idb.reads.reset();
    do {
      const page = await merged(w, after);
      expect(page.createsTotal).toBe(N);
      seen.push(...page.creates.map((draft) => draft.local_id));
      after = page.createsNext;
      pages += 1;
    } while (after !== null && after !== undefined && pages < 20);
    expect(seen).toEqual(ids);
    expect(pages).toBe(Math.ceil(N / WINDOW));
    expect(bodies(w).max).toBeLessThanOrEqual(WINDOW);
    expect(reads(w).max).toBeLessThanOrEqual(WINDOW);
  });

  test("windows that exactly fill a page say so: 100 saved changes have no next window, 101 have one", async () => {
    for (const [count, more] of [
      [WINDOW, false],
      [WINDOW + 1, true],
    ] as const) {
      const w = await outboxWorld();
      await saveEdits(w, count);
      const page = await merged(w);
      expect(page.creates, `${count}`).toHaveLength(WINDOW);
      expect(page.createsNext === null, `${count}`).toBe(!more);
      expect(page.createsTotal, `${count}`).toBe(count);
    }
  });

  test("a resource the cache holds reads none of its drafts or bodies, and says so", async () => {
    const w = await outboxWorld();
    await saveEdits(w, 30);
    w.put("cache", [cacheRow({ id: "new-person", version: 1 })]);
    w.env.idb.reads.reset();
    const result = await merged(w);
    expect(result.creates).toEqual([]);
    expect(result.createsTotal).toBe(0);
    expect(result.createsNext).toBeNull();
    expect(reads(w).rows).toBe(0);
    expect(bodies(w).rows).toBe(0);
  });

  test("only queued and in-flight changes count: a settled one is not a pending create", async () => {
    const w = await outboxWorld();
    const rows = Array.from({ length: 12 }, (_, i) =>
      draftRow({
        local_id: `s${i}`,
        created_seq: i + 1,
        status: (
          [
            "queued",
            "in_flight",
            "acknowledged",
            "rejected",
            "superseded",
            "version_conflict",
          ] as const
        )[i % 6],
        index_targets: ["new-person"],
        target_resource_ids: ["new-person"],
      } as never),
    );
    seedRows(w, rows);
    const result = await merged(w);
    expect(result.creates.map((draft) => draft.local_id)).toEqual([
      "s0",
      "s1",
      "s6",
      "s7",
    ]);
    expect(result.createsTotal).toBe(4);
  });

  test("a change of ANOTHER resource that merely lists this one as a side effect is not a create of it", async () => {
    const w = await outboxWorld();
    seedRows(w, [
      draftRow({
        local_id: "other",
        created_seq: 1,
        index_targets: ["new-person", "someone"],
        target_resource_ids: ["someone"],
        side_effect_bases: { "new-person": 3 },
      } as never),
    ]);
    const result = await merged(w);
    expect(result.creates).toEqual([]);
    expect(result.createsTotal).toBe(0);
  });

  test("the whole dispatcher over a new resource and 119 saved edits: every one is sent, in order, one request in flight", async () => {
    const w = await outboxWorld();
    w.start();
    await w.settle();
    const ids = await saveEdits(w, 120);
    await w.settle();
    await w.advance(60_000);
    expect(w.sent.map((r) => r.key)).toEqual(ids);
    expect(w.drafts().every((row) => row.status === "acknowledged")).toBe(true);
    w.dispatcher.stop();
  });
});

// A header-only copy is what the plans read: keep `headerOf` referenced for readers of the helper.
void headerOf;

// @vitest-environment node
import { describe, expect, test } from "vitest";
import { selectCandidate } from "../../src/data/model/dispatch";
import {
  summariseQueue,
  summaryFromCounts,
} from "../../src/data/model/queue-summary";
import type { DraftRow } from "../../src/data/model/types";
import { summariseWork } from "../../src/data/plans/fence";
import {
  readDispatchWindow,
  readQueuePage,
  readQueueSummary,
} from "../../src/data/plans/outbox";
import { w as write } from "../../src/data/store/port";
import { outboxWorld } from "../support/data/outbox-world";
import { draftRow, headerOf } from "../support/data/rows";
import { Rng } from "../support/data/sync-pages";

/**
 * R3 and R6: the dispatcher, the queue, the summary, the consent count and the page reconciliation work on a BOUNDED set of
 * HEADERS chosen by index, whatever the length of the queue and whatever the payloads it retains (decision D-23). FIXTURE evidence:
 * the double of IndexedDB counts the rows each plan reads (`idb.reads`), which is how "bounded" is asserted; it is not a measurement
 * of a real engine's memory (the real-engine figures are the profiling programme's, with the device roster still open).
 */
const KIB = 1024;
const target = (id: string) => ({
  index_targets: [id],
  target_resource_ids: [id],
});

const seed = (
  w: Awaited<ReturnType<typeof outboxWorld>>,
  rows: ReturnType<typeof draftRow>[],
) => {
  w.put("drafts", rows);
  w.setSync({ draft_seq: Math.max(0, ...rows.map((row) => row.created_seq)) });
};
const conflicts = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) =>
    draftRow({
      local_id: `conflict-${from + i}`,
      created_seq: from + i,
      status: "version_conflict",
      ...target(`blocked-${from + i}`),
    }),
  );
const independent = (seq: number, id = "independent") =>
  draftRow({
    local_id: id,
    created_seq: seq,
    status: "queued",
    ...target(`free-${id}`),
    command: { kind: "create", id },
  });

describe("R3: retained conflicts never starve an independent draft behind them", () => {
  test("500 retained conflicts, then an independent draft: it is sent (the reviewer's reproduction), and in the first step", async () => {
    const w = await outboxWorld();
    seed(w, [...conflicts(500), independent(501)]);
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["independent"]);
  });

  test("the same, with twelve further five-second intervals and nothing else to wake it (the reproduction's shape)", async () => {
    const w = await outboxWorld();
    seed(w, [...conflicts(500), independent(501)]);
    w.start();
    await w.settle();
    for (let i = 0; i < 12; i += 1) await w.advance(5_000);
    expect(w.sent.map((s) => s.key)).toEqual(["independent"]);
  });

  test("5,000 retained conflicts carrying 8 KiB bodies cost a handful of header reads and ONE body: the one that is sent", async () => {
    const w = await outboxWorld();
    const big = Array.from({ length: 5_000 }, (_, i) =>
      draftRow({
        local_id: `c${i}`,
        created_seq: i + 1,
        status: "version_conflict",
        ...target(`b${i}`),
        command: { kind: "import", payload: "x".repeat(8 * KIB) },
      }),
    );
    seed(w, [...big, independent(5_001)]);
    w.env.idb.reads.reset();
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["independent"]);
    const reads = w.env.idb.reads.rows;
    // The window of candidates is the sendable drafts, so the 5,000 conflicts are never read; the one body read is the sent draft's.
    expect(reads.get("draft_commands") ?? 0).toBeLessThanOrEqual(2);
    expect(reads.get("drafts") ?? 0).toBeLessThan(150);
  });

  test("candidates BLOCKED behind a conflict (a shared target) span several windows: a draft beyond them is still reached by carried progress", async () => {
    const w = await outboxWorld({ config: { queueWorkingSet: 20 } });
    const head = draftRow({
      local_id: "head",
      created_seq: 1,
      status: "version_conflict",
      ...target("hot"),
    });
    const blocked = Array.from({ length: 95 }, (_, i) =>
      draftRow({
        local_id: `blocked-${i}`,
        created_seq: i + 2,
        status: "queued",
        ...target("hot"),
      }),
    );
    seed(w, [head, ...blocked, independent(200)]);
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["independent"]);
    // The blocked drafts wait; nothing was sent out of order, and the dispatcher keeps looking, sparingly.
    expect(w.drafts().filter((d) => d.status === "queued")).toHaveLength(95);
  });

  test("dependencies across windows: a dependant waits for a dependency in an earlier window, and goes once it is settled", async () => {
    const w = await outboxWorld({ config: { queueWorkingSet: 10 } });
    const gate = draftRow({
      local_id: "gate",
      created_seq: 1,
      status: "version_conflict",
      ...target("g"),
    });
    const filler = Array.from({ length: 35 }, (_, i) =>
      draftRow({
        local_id: `filler-${i}`,
        created_seq: i + 2,
        status: "queued",
        ...target("g"),
      }),
    );
    const dependant = draftRow({
      local_id: "dependant",
      created_seq: 100,
      status: "queued",
      ...target("d"),
      depends_on: ["filler-3"],
    });
    seed(w, [gate, ...filler, dependant]);
    w.start();
    await w.settle();
    expect(w.sent).toEqual([]);
    // The dependency is settled (it was acknowledged and has left), but the queue is otherwise unchanged.
    w.env.idb.clearStore(`atlas-${w.service.account}`, "drafts");
    w.env.idb.clearStore(`atlas-${w.service.account}`, "draft_commands");
    w.put("drafts", [
      gate,
      ...filler.filter((d) => d.local_id !== "filler-3"),
      dependant,
    ]);
    w.fire();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["dependant"]);
  });

  test("a draft that arrives while the dispatcher is working through a long blocked run is sent in its turn, after nothing it should precede", async () => {
    const w = await outboxWorld({ config: { queueWorkingSet: 10 } });
    const head = draftRow({
      local_id: "head",
      created_seq: 1,
      status: "version_conflict",
      ...target("hot"),
    });
    const blocked = Array.from({ length: 60 }, (_, i) =>
      draftRow({
        local_id: `blocked-${i}`,
        created_seq: i + 2,
        status: "queued",
        ...target("hot"),
      }),
    );
    seed(w, [head, ...blocked]);
    w.start();
    await w.settle();
    expect(w.sent).toEqual([]);
    const out = await w.outbox.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: "fresh",
          role: "primary",
          basis: "resource",
          versionChecked: false,
          seedIfUntracked: 1,
        },
      ],
      build: () => ({ command: { kind: "create", id: "fresh" } }),
    });
    expect(out.kind).toBe("queued");
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual([
      out.kind === "queued" ? out.localId : "",
    ]);
  });

  test("a queue that is entirely blocked is looked at again, a little less often each time, and a settled draft is then found", async () => {
    const w = await outboxWorld({ config: { queueWorkingSet: 10 } });
    const gate = draftRow({
      local_id: "gate",
      created_seq: 1,
      status: "version_conflict",
      ...target("g"),
    });
    const rest = Array.from({ length: 12 }, (_, i) =>
      draftRow({
        local_id: `q${i}`,
        created_seq: i + 2,
        status: "queued",
        ...target("g"),
      }),
    );
    seed(w, [gate, ...rest]);
    w.start();
    await w.settle();
    expect(w.sent).toEqual([]);
    // Another page's commit settles the gate; nothing tells this dispatcher, which finds it on its own rescan.
    w.env.idb.seed(`atlas-${w.service.account}`, "drafts", [
      { ...headerOf(gate), status: "acknowledged" },
    ]);
    for (let i = 0; i < 5 && w.sent.length === 0; i += 1)
      await w.advance(10_000);
    // Found by its own rescan, and then sent in queue order (they share one target: a chain).
    expect(w.sent.map((s) => s.key)).toEqual(
      Array.from({ length: 12 }, (_, i) => `q${i}`),
    );
  });

  test("a draft whose local writes stopped (restored from the record) is not counted as a back-off and does not hide the others", async () => {
    const w = await outboxWorld();
    seed(w, [independent(1, "stopped"), independent(2, "fine")]);
    w.setSync({ local_write_streaks: { "receipt:stopped": 3 } });
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["fine"]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
  });

  test("a streak left behind by a draft that no longer exists does not stop anything", async () => {
    const w = await outboxWorld();
    seed(w, [independent(1, "alive")]);
    w.setSync({ local_write_streaks: { "receipt:gone": 3 } });
    w.start();
    await w.settle();
    expect(w.sent.map((s) => s.key)).toEqual(["alive"]);
    expect(w.dispatcher.state.get().kind).toBe("idle");
  });
});

describe("R3: the indexed selection is the whole-queue rule", () => {
  /** A random queue: statuses, shared targets, dependencies on earlier drafts, back-offs, pauses and a review hold. */
  const randomQueue = (seed_: number, size: number): DraftRow[] => {
    const rng = new Rng(seed_);
    const statuses = [
      "queued",
      "queued",
      "queued",
      "in_flight",
      "version_conflict",
      "operation_conflict",
      "rejected",
      "acknowledged",
      "blocked",
    ] as const;
    const rows: DraftRow[] = [];
    for (let i = 0; i < size; i += 1) {
      const status = rng.pick(statuses);
      const targets = rng.bool(0.7)
        ? [`t${rng.int(6)}`, ...(rng.bool(0.2) ? [`t${rng.int(6)}`] : [])]
        : [`own-${i}`];
      const earlier = rows.filter((r) => r.created_seq < i + 1);
      rows.push(
        headerOf(
          draftRow({
            local_id: `d${i}`,
            created_seq: i + 1,
            status,
            index_targets: [...new Set(targets)],
            target_resource_ids: [...new Set(targets)],
            depends_on:
              earlier.length > 0 && rng.bool(0.25)
                ? [rng.pick(earlier).local_id]
                : [],
            retry_state:
              status === "in_flight" && rng.bool(0.4)
                ? {
                    state: rng.bool(0.5) ? "paused" : "backing_off",
                    since: 0,
                  }
                : null,
            attempts: status === "in_flight" ? rng.int(4) : 0,
            last_attempt_at:
              status === "in_flight" ? "2026-10-01T09:00:00.000Z" : null,
            review_block:
              (status === "queued" || status === "in_flight") && rng.bool(0.04)
                ? { kind: "defaults", kinds: [] }
                : null,
          }),
        ),
      );
    }
    return rows;
  };

  test("over 200 random queues the plan's pick, taken through turns of a small window, is the reference rule's pick", async () => {
    for (let n = 0; n < 200; n += 1) {
      const w = await outboxWorld({ config: { queueWorkingSet: 3 } });
      const rows = randomQueue(1000 + n, 4 + (n % 25));
      w.put(
        "drafts",
        rows.map((row) => ({ ...row, command: { kind: "x" } })),
      );
      const now = Date.parse("2026-10-01T09:00:03.000Z");
      const oracle = selectCandidate({
        rows: [...rows].sort((a, b) => a.created_seq - b.created_seq),
        now,
        blockedUntil: new Map(),
      });
      let after: number | undefined;
      let picked: string | null = null;
      for (let turn = 0; turn < 200; turn += 1) {
        const window = await w.service.store.run(readDispatchWindow, {
          incarnationId: w.service.incarnationId,
          now,
          blockedUntil: new Map(),
          windowSize: 3,
          ...(after === undefined ? {} : { after }),
        });
        if (window.pick !== null) {
          picked = window.pick.local_id;
          break;
        }
        if (window.next === null) break;
        after = window.next;
      }
      expect(picked, `queue ${n}`).toBe(oracle.pick?.local_id ?? null);
    }
  });

  test("the whole queue's waiting counts are the reference's: paused, backing-off and the hold", async () => {
    for (let n = 0; n < 60; n += 1) {
      const w = await outboxWorld();
      const rows = randomQueue(5000 + n, 6 + (n % 30));
      w.put(
        "drafts",
        rows.map((row) => ({ ...row, command: { kind: "x" } })),
      );
      const now = Date.parse("2026-10-01T09:00:03.000Z");
      const oracle = selectCandidate({
        rows: [...rows].sort((a, b) => a.created_seq - b.created_seq),
        now,
        blockedUntil: new Map(),
      });
      const window = await w.service.store.run(readDispatchWindow, {
        incarnationId: w.service.incarnationId,
        now,
        blockedUntil: new Map(),
      });
      expect(window.selection.holdFrom, `queue ${n}`).toBe(oracle.holdFrom);
      expect(window.selection.paused, `queue ${n}`).toBe(oracle.paused);
    }
  });
});

describe("R6: the summary, the queue and the consent count are exact and never read a body", () => {
  const retained = (
    n: number,
    payload: number,
  ): ReturnType<typeof draftRow>[] => {
    const statuses = [
      "queued",
      "in_flight",
      "version_conflict",
      "operation_conflict",
      "rejected",
      "blocked",
      "acknowledged",
    ] as const;
    return Array.from({ length: n }, (_, i) => {
      const status = statuses[i % statuses.length] as DraftRow["status"];
      return draftRow({
        local_id: `r${i}`,
        created_seq: i + 1,
        status,
        ...target(`res-${i}`),
        command: { kind: "import", payload: "x".repeat(payload) },
        held_pending_cache: status === "acknowledged" && i % 2 === 0,
        unavailable_outcome: status === "acknowledged" && i % 4 === 1,
        review_block:
          status === "in_flight" && i % 11 === 1
            ? { kind: "defaults", kinds: [] }
            : null,
      });
    });
  };

  test("the summary equals the reference over the whole list, and 200 retained 64 KiB imports are never read", async () => {
    const w = await outboxWorld();
    const rows = retained(200, 64 * KIB);
    seed(w, rows);
    w.env.idb.measureBytes = true;
    w.env.idb.reads.reset();
    const summary = await w.service.store.run(readQueueSummary, {
      incarnationId: w.service.incarnationId,
    });
    expect(summary).toEqual(summariseQueue(rows.map(headerOf)));
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    // About 12.5 MiB of bodies are retained; what the summary read is a few headers' worth.
    expect(w.env.idb.reads.bytes.get("drafts") ?? 0).toBeLessThan(160 * KIB);
    // Rows read: the acknowledged drafts (the only status whose flags decide membership) and the reviewing ones, not the 200.
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBeLessThan(60);
    expect(
      summaryFromCounts({ waiting: 1, needsDecision: 2, held: 3 }).total,
    ).toBe(6);
  });

  test("the consent count and digest are exact over the member headers and read no body", async () => {
    const w = await outboxWorld();
    const rows = retained(140, 64 * KIB);
    seed(w, rows);
    const fromList = await w.service.store.run(summariseWork, {
      incarnationId: w.service.incarnationId,
    });
    w.env.idb.measureBytes = true;
    w.env.idb.reads.reset();
    const again = await w.service.store.run(summariseWork, {
      incarnationId: w.service.incarnationId,
    });
    expect(again).toEqual(fromList);
    // The population: queued, in_flight, rejected, blocked, both conflicts, and the acknowledged drafts that are held.
    expect(again.count).toBeGreaterThan(100);
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    expect(w.env.idb.reads.bytes.get("drafts") ?? 0).toBeLessThan(400 * KIB);
  });

  test("the queue is a page of headers: 100 rows with a 'more' flag, further rows on request, exact dependants, no body", async () => {
    const w = await outboxWorld();
    const rows = [
      ...retained(260, 32 * KIB),
      draftRow({
        local_id: "child",
        created_seq: 300,
        status: "queued",
        ...target("child"),
        depends_on: ["r0"],
      }),
    ];
    seed(w, rows);
    w.env.idb.reads.reset();
    const first = await w.service.store.run(readQueuePage, {
      incarnationId: w.service.incarnationId,
      limit: 100,
    });
    expect(first.rows).toHaveLength(100);
    expect(first.more).toBe(true);
    expect(first.dependants.r0).toBe(1);
    expect(first.rows.map((r) => r.created_seq)).toEqual(
      [...first.rows.map((r) => r.created_seq)].sort((a, b) => a - b),
    );
    expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    // Every visible draft is reachable by asking for more, and a page never invents or drops one.
    const all = await w.service.store.run(readQueuePage, {
      incarnationId: w.service.incarnationId,
      limit: 1_000,
    });
    expect(all.more).toBe(false);
    const visible = rows
      .map(headerOf)
      .filter(
        (draft) =>
          summariseQueue([draft]).total > 0 ||
          draft.status === "queued" ||
          draft.status === "rejected",
      );
    expect(all.rows.map((r) => r.local_id)).toEqual(
      visible.map((r) => r.local_id),
    );
  });

  test("the facade's queue loads nothing until it has a subscriber, and the next window REPLACES the first", async () => {
    const w = await outboxWorld();
    seed(
      w,
      Array.from({ length: 230 }, (_, i) =>
        draftRow({
          local_id: `p${i}`,
          created_seq: i + 1,
          status: "version_conflict",
          ...target(`p${i}`),
          command: { kind: "import", payload: "x".repeat(4 * KIB) },
        }),
      ),
    );
    w.env.idb.reads.reset();
    expect(w.outbox.queue.get()).toEqual({ status: "loading" });
    await w.settle();
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBe(0);
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    const loaded = w.outbox.queue.get();
    expect(loaded.status === "ready" && loaded.value.rows.length).toBe(100);
    expect(loaded.status === "ready" && loaded.value.previous).toBe(false);
    w.outbox.showNext();
    await w.settle();
    const next = w.outbox.queue.get();
    // The second window is rows 101 to 200, ALONE: the first is not held any longer.
    expect(next.status === "ready" && next.value.rows.length).toBe(100);
    expect(
      next.status === "ready" && next.value.rows.map((r) => r.local_id),
    ).toEqual(Array.from({ length: 100 }, (_, i) => `p${100 + i}`));
    expect(next.status === "ready" && next.value.previous).toBe(true);
    off();
  });
});

describe("R6 (revision 6): the visible queue is ONE window, whichever window is shown", () => {
  const SIZE = 100;
  const many = (n: number, over: Partial<ReturnType<typeof draftRow>> = {}) =>
    Array.from({ length: n }, (_, i) =>
      draftRow({
        local_id: `q${String(i).padStart(5, "0")}`,
        created_seq: i + 1,
        status: "queued",
        ...target(`res-${i}`),
        command: { kind: "import", payload: "x".repeat(2 * KIB) },
        ...over,
      }),
    );
  const shown = (w: Awaited<ReturnType<typeof outboxWorld>>) => {
    const state = w.outbox.queue.get();
    if (state.status !== "ready") throw new Error(`queue ${state.status}`);
    return state.value;
  };
  const ids = (w: Awaited<ReturnType<typeof outboxWorld>>) =>
    shown(w).rows.map((r) => r.local_id);

  test("1,050 drafts: ten windows forward, ten back; each window is its 100 rows and no more, and a window is not a prefix", async () => {
    const w = await outboxWorld();
    seed(w, many(1_050));
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    expect(ids(w)).toEqual(
      many(1_050)
        .slice(0, SIZE)
        .map((r) => r.local_id),
    );
    for (let window = 1; window <= 10; window += 1) {
      w.env.idb.reads.reset();
      w.outbox.showNext();
      await w.settle();
      const rows = shown(w).rows;
      expect(rows.map((r) => r.created_seq)).toEqual(
        Array.from(
          { length: window === 10 ? 50 : SIZE },
          (_, i) => window * SIZE + i + 1,
        ),
      );
      expect(shown(w).previous).toBe(true);
      expect(shown(w).more).toBe(window < 10);
      // What reaching this window read: a window and a look past its end, never the windows before it.
      expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBeLessThanOrEqual(
        2 * SIZE + 1,
      );
      expect(w.env.idb.reads.maxBatch.get("drafts") ?? 0).toBeLessThanOrEqual(
        SIZE,
      );
      expect(w.env.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    }
    // The last window has no next: asking for one changes nothing.
    w.outbox.showNext();
    await w.settle();
    expect(shown(w).rows).toHaveLength(50);
    for (let window = 9; window >= 0; window -= 1) {
      w.outbox.showPrevious();
      await w.settle();
      expect(shown(w).rows[0]?.created_seq).toBe(window * SIZE + 1);
      expect(shown(w).previous).toBe(window > 0);
    }
    // The first has no previous: asking for one changes nothing.
    w.outbox.showPrevious();
    await w.settle();
    expect(shown(w).rows[0]?.created_seq).toBe(1);
    off();
  });

  test("a refresh while the fifth window is shown re-reads THAT window, not the 500 rows before it", async () => {
    const w = await outboxWorld();
    seed(w, many(1_050));
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    for (let i = 0; i < 4; i += 1) {
      w.outbox.showNext();
      await w.settle();
    }
    expect(shown(w).rows[0]?.created_seq).toBe(401);
    // Another draft is saved (through the public facade, so a change of the store triggers the live query).
    w.env.idb.reads.reset();
    const out = await w.outbox.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: "new",
          role: "primary",
          basis: "resource",
          versionChecked: false,
          seedIfUntracked: 1,
        },
      ],
      build: () => ({ command: { kind: "create", id: "new" } }),
    });
    expect(out.kind).toBe("queued");
    await w.settle();
    expect(shown(w).rows[0]?.created_seq).toBe(401);
    // Every refresh read about a window (at most two chunks and the dependants' counts), however many times it ran; a cumulative
    // limit would have read 500 rows each time.
    const reads = w.env.idb.reads.rows.get("drafts") ?? 0;
    expect(w.env.idb.reads.maxBatch.get("drafts") ?? 0).toBeLessThanOrEqual(
      SIZE,
    );
    expect(reads).toBeLessThan(500);
    off();
  });

  test("windows over a queue full of rows the tabs do not show: the hidden rows are skipped, nothing visible is lost or repeated", async () => {
    const w = await outboxWorld();
    // Acknowledged drafts that have left every tab, in long runs between the visible ones.
    const rows = Array.from({ length: 700 }, (_, i) =>
      draftRow({
        local_id: `m${String(i).padStart(4, "0")}`,
        created_seq: i + 1,
        status: i % 7 === 0 ? "queued" : "superseded",
        ...target(`m${i}`),
      }),
    );
    seed(w, rows);
    const visible = rows.filter((r) => r.status === "queued");
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    const seen: string[] = [];
    for (;;) {
      seen.push(...ids(w));
      if (!shown(w).more) break;
      w.outbox.showNext();
      await w.settle();
    }
    expect(seen).toEqual(visible.map((r) => r.local_id));
    off();
  });

  test("a window whose rows have all gone (sent or discarded meanwhile) falls back to the one before it, never an empty queue with a way back", async () => {
    const w = await outboxWorld();
    seed(w, many(250));
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    w.outbox.showNext();
    await w.settle();
    expect(shown(w).rows[0]?.created_seq).toBe(101);
    // Everything from the second window on goes (in a real transaction, so the live query hears of it).
    const gone = many(250)
      .slice(100)
      .map((row) => row.local_id);
    await w.service.store.run(
      {
        name: "test.removeFrom",
        scope: ["drafts", "draft_commands"],
        mode: "readwrite",
        durability: "strict",
        read: async () => null,
        decide: () => ({
          writes: [
            write.bulkDelete("drafts", gone),
            write.bulkDelete("draft_commands", gone),
          ],
          result: null,
        }),
      },
      null,
    );
    await w.settle();
    // Not an empty window with a way back: the first window, with no way back.
    expect(shown(w).rows).toHaveLength(100);
    expect(shown(w).rows[0]?.created_seq).toBe(1);
    expect(shown(w).previous).toBe(false);
    off();
  });

  test("with no subscriber nothing is read, however the person has navigated (the window is released with its last listener)", async () => {
    const w = await outboxWorld();
    seed(w, many(300));
    const off = w.outbox.queue.subscribe(() => undefined);
    await w.settle();
    w.outbox.showNext();
    await w.settle();
    off();
    w.env.idb.reads.reset();
    const out = await w.outbox.enqueue({
      endpoint: "/commands",
      targets: [
        {
          resourceId: "later",
          role: "primary",
          basis: "resource",
          versionChecked: false,
          seedIfUntracked: 1,
        },
      ],
      build: () => ({ command: { kind: "create", id: "later" } }),
    });
    expect(out.kind).toBe("queued");
    await w.settle();
    expect(w.env.idb.reads.rows.get("drafts") ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("R6: a delta page reads only the drafts its reconciliation can touch", () => {
  test("with 300 large retained drafts and a page that names one resource, no body is read and few headers", async () => {
    const { engineWorld } = await import("../support/data/engine-world");
    const { cacheRow, effectRow, versionRow } = await import(
      "../support/data/rows"
    );
    const w = await engineWorld({ cursor: "cursor-0" });
    const rows = Array.from({ length: 300 }, (_, i) =>
      draftRow({
        local_id: `big-${i}`,
        created_seq: i + 1,
        status: i % 3 === 0 ? "version_conflict" : "queued",
        ...target(`res-${i}`),
        command: { kind: "import", payload: "x".repeat(16 * KIB) },
      }),
    );
    w.put("drafts", rows);
    w.put("cache", [cacheRow({ id: "res-0", version: 1 })]);
    w.put("resource_versions", [versionRow({ resource_id: "res-0" })]);
    w.put("pending_effects", [
      effectRow({ resource_id: "res-0", local_id: "big-0", display: null }),
    ]);
    w.env.idb.reads.reset();
    w.start();
    await w.settle();
    const reads = w.env.idb.reads.rows;
    expect(w.requests.length).toBeGreaterThan(0);
    expect(reads.get("draft_commands") ?? 0).toBe(0);
    // The owner of the pending effect and the drafts that share the tracked resource, not the 300.
    expect(reads.get("drafts") ?? 0).toBeLessThan(10);
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AccountService } from "../../src/data/engine/account-service";
import type {
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../src/data/model/types";
import {
  pruneMaterialiseSequences,
  readMaterialiseDiscovery,
  readMaterialiseSequence,
  readMaterialiseSequences,
  SEQUENCE_WINDOW,
  writeMaterialiseDiscovery,
  writeMaterialiseSequence,
} from "../../src/data/plans/materialise";
import {
  issueTimerOrder,
  parseTimerCopy,
  readTimerCopy,
  reconcileTimerCopy,
  TIMER_COPY_ROWS,
  writeTimerCopy,
} from "../../src/data/plans/timer-copy";
import {
  commitMaterialiseSequence,
  commitTimerCopy,
} from "../../src/data/ui/task-records";
import { DB, defaultsWorld } from "../support/data/defaults-world";

/**
 * W27 (the catch-up sequences) and W28 (the running-timer copy), WEB-10c: the compare-and-set, the guard set of a response-derived write
 * (INC, CLS, EPO) applied from the singleton read in the SAME transaction, the bounded reads, the housekeeping, the tolerant copy and
 * its quota admission. Run against the production plans over the double of IndexedDB, through the store so each guard is exercised on
 * its own, and through the slice-facing commit (G1/G2/G5 are the account service's). FIXTURE evidence.
 */
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TASK = "aaaaaaaa-0000-4000-8000-000000000002";

const row = (
  over: Partial<MaterialiseSequenceRow> = {},
): MaterialiseSequenceRow => ({
  task_id: TASK,
  through_date: "2026-10-25",
  sequence_generation: "g1",
  phase: "ready",
  attempt: null,
  read_seq: 0,
  successful_calls: 0,
  last_known_position: null,
  started_at: 1,
  read_failures: 0,
  stop: null,
  trigger: "daily",
  ...over,
});

async function bound() {
  const t = await defaultsWorld({ online: false, noReader: true });
  await t.settle();
  const service = t.env.service() as AccountService;
  expect(service).not.toBeNull();
  const seed = (patch: Partial<SyncStateRow>) => {
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    t.world.idb.seed(DB, "sync_state", [{ ...sync, ...patch }]);
  };
  const stored = (key: MaterialiseSequenceRow = row()) =>
    t.world.idb.peek(DB, "materialise_sequences", [
      key.task_id,
      key.through_date,
    ]) as MaterialiseSequenceRow | undefined;
  const write = (
    input: {
      expected: Parameters<
        typeof writeMaterialiseSequence.decide
      >[1]["expected"];
      next: MaterialiseSequenceRow | null;
      key?: { task_id: string; through_date: string };
    },
    captured: Partial<ReturnType<AccountService["capture"]>> = {},
  ) =>
    service.store.run(writeMaterialiseSequence, {
      captured: { ...service.capture(1), ...captured },
      key: input.key ?? { task_id: TASK, through_date: "2026-10-25" },
      expected: input.expected,
      next: input.next,
    });
  return { t, service, seed, stored, write };
}

describe("W27: the compare-and-set", () => {
  test("a new key is written only while it is absent; a second create of the same key is stale and returns what is stored", async () => {
    const { write, stored } = await bound();
    expect(await write({ expected: null, next: row() })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: row() },
    });
    expect(stored()).toEqual(row());
    // MU-10C-11: a CAS that writes when stale overwrites another runner's sequence.
    const second = await write({
      expected: null,
      next: row({ sequence_generation: "g2" }),
    });
    expect(second).toEqual({
      kind: "applied",
      value: { kind: "stale", stored: row() },
    });
    expect(stored()?.sequence_generation).toBe("g1");
  });

  test("a transition applies only to the row it was decided on: generation, phase, read sequence and attempt key", async () => {
    const { write, stored } = await bound();
    const submitting = row({
      phase: "submitting",
      attempt: { key: "k1", body: "{}" },
    });
    await write({ expected: null, next: submitting });
    const expected = {
      sequence_generation: "g1",
      phase: "submitting" as const,
      read_seq: 0,
      attempt_key: "k1",
    };
    for (const wrong of [
      { ...expected, sequence_generation: "g0" },
      { ...expected, phase: "ready" as const },
      { ...expected, read_seq: 1 },
      { ...expected, attempt_key: "k0" },
      { ...expected, attempt_key: null },
    ]) {
      const out = await write({
        expected: wrong,
        next: row({ phase: "awaiting_position_read", read_seq: 1 }),
      });
      expect(out).toEqual({
        kind: "applied",
        value: { kind: "stale", stored: submitting },
      });
    }
    expect(stored()).toEqual(submitting);
    const moved = row({ phase: "awaiting_position_read", read_seq: 1 });
    expect(await write({ expected, next: moved })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: moved },
    });
    expect(stored()).toEqual(moved);
  });

  test("an expectation of a row that is gone is stale (absent), and a delete removes the row", async () => {
    const { write, stored } = await bound();
    const expected = {
      sequence_generation: "g1",
      phase: "ready" as const,
      read_seq: 0,
      attempt_key: null,
    };
    expect(await write({ expected, next: null })).toEqual({
      kind: "applied",
      value: { kind: "stale", stored: null },
    });
    await write({ expected: null, next: row() });
    expect(await write({ expected, next: null })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: null },
    });
    expect(stored()).toBeUndefined();
  });

  test("a replacement under another key is refused (stale), never written beside the key it was asked for", async () => {
    const { write, stored } = await bound();
    await write({ expected: null, next: row() });
    const out = await write({
      expected: {
        sequence_generation: "g1",
        phase: "ready",
        read_seq: 0,
        attempt_key: null,
      },
      next: row({ through_date: "2026-10-26" }),
    });
    expect(out.kind === "applied" && out.value.kind).toBe("stale");
    expect(stored(row({ through_date: "2026-10-26" }))).toBeUndefined();
  });
});

describe("W27: the guards of a response-derived write", () => {
  test("INC, CLS and EPO each write nothing", async () => {
    const { seed, write, stored } = await bound();
    expect(
      await write({ expected: null, next: row() }, { incarnationId: "x" }),
    ).toEqual({ kind: "dropped", reason: "incarnation" });
    seed({ stamp: { epoch: 2 } });
    expect(await write({ expected: null, next: row() }, { epoch: 1 })).toEqual({
      kind: "dropped",
      reason: "epoch_superseded",
    });
    seed({
      stamp: null,
      draft_fence: {
        token: "f",
        started_at: 1,
        operation_ids: [],
        consent_digest: "d",
        closing: true,
      },
    });
    expect(await write({ expected: null, next: row() })).toEqual({
      kind: "dropped",
      reason: "closing",
    });
    expect(stored()).toBeUndefined();
  });

  test("through the slice's commit: the service's guards apply and nothing throws", async () => {
    const { service, stored } = await bound();
    const out = await commitMaterialiseSequence(service, service.capture(1), {
      key: { task_id: TASK, through_date: "2026-10-25" },
      expected: null,
      next: row(),
    });
    expect(out).toEqual({
      kind: "applied",
      value: { kind: "written", stored: row() },
    });
    service.dispose("identity");
    const late = await commitMaterialiseSequence(service, service.capture(1), {
      key: { task_id: TASK, through_date: "2026-10-25" },
      expected: {
        sequence_generation: "g1",
        phase: "ready",
        read_seq: 0,
        attempt_key: null,
      },
      next: null,
    });
    expect(late.kind).not.toBe("applied");
    expect(stored()).toEqual(row());
  });
});

describe("W27: bounded reads and housekeeping", () => {
  test("reads by key, by task (its own key range only) and for the account, each at most one window", async () => {
    const { t, service } = await bound();
    const rows = [
      row(),
      row({ through_date: "2026-10-24" }),
      row({ task_id: OTHER_TASK }),
    ];
    t.world.idb.seed(DB, "materialise_sequences", rows);
    expect(
      await service.store.run(readMaterialiseSequence, {
        incarnationId: service.incarnationId,
        key: { task_id: TASK, through_date: "2026-10-24" },
      }),
    ).toEqual(rows[1]);
    const mine = await service.store.run(readMaterialiseSequences, {
      incarnationId: service.incarnationId,
      taskId: TASK,
    });
    expect(mine.map((r) => r.through_date)).toEqual([
      "2026-10-24",
      "2026-10-25",
    ]);
    const many = Array.from({ length: SEQUENCE_WINDOW + 1 }, (_, i) =>
      row({
        task_id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
      }),
    );
    t.world.idb.seed(DB, "materialise_sequences", many);
    const all = await service.store.run(readMaterialiseSequences, {
      incarnationId: service.incarnationId,
      taskId: null,
    });
    expect(all).toHaveLength(SEQUENCE_WINDOW);
  });

  test("pruning removes the task's EARLIER stopped and ready sequences, never a running one, a later day or another task's", async () => {
    const { t, service } = await bound();
    const rows = [
      row({ through_date: "2026-10-20", phase: "stopped" }),
      row({ through_date: "2026-10-21", phase: "ready" }),
      row({ through_date: "2026-10-22", phase: "submitting" }),
      row({ through_date: "2026-10-23", phase: "awaiting_position_read" }),
      row({ through_date: "2026-10-25", phase: "stopped" }),
      row({ task_id: OTHER_TASK, through_date: "2026-10-20" }),
    ];
    t.world.idb.seed(DB, "materialise_sequences", rows);
    const out = await service.store.run(pruneMaterialiseSequences, {
      captured: service.capture(1),
      task_id: TASK,
      before: "2026-10-25",
    });
    expect(out).toEqual({ kind: "applied", value: { removed: 2 } });
    const left = await service.store.run(readMaterialiseSequences, {
      incarnationId: service.incarnationId,
      taskId: null,
    });
    expect(left.map((r) => `${r.task_id.slice(-1)}:${r.through_date}`)).toEqual(
      ["1:2026-10-22", "1:2026-10-23", "1:2026-10-25", "2:2026-10-20"],
    );
  });
});

describe("W28: the running-timer copy", () => {
  const session = (n: number) => ({
    access: "available",
    id: `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`,
  });
  // Revision 2 (review R10, DA-T2): a copy carries its read's place in the observation order; `read_at` is shown, never compared.
  const copy = (order: number, running = [session(1)], readAt = 1_000) => ({
    format: 2 as const,
    order,
    read_at: readAt,
    complete: true,
    running,
  });

  /**
   * Adaptation (revision 2): this case compared `read_at` (ms) and kept the copy whose clock was later. Its intent, "an earlier read
   * never replaces a later one", is kept over the observation order: the later ORDER stays, whatever either clock says.
   */
  test("writes one record, keeps a copy of a LATER order than the incoming one (whatever the clocks), and removes it on null", async () => {
    const { t, service } = await bound();
    const run = (c: ReturnType<typeof copy> | null) =>
      service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: c,
      });
    expect(await run(copy(2, [session(1)], 100))).toEqual({
      kind: "applied",
      value: { written: true, stored: copy(2, [session(1)], 100) },
    });
    expect(await run(copy(1, [], 200))).toEqual({
      kind: "applied",
      value: { written: false, stored: copy(2, [session(1)], 100) },
    });
    expect(
      await service.store.run(readTimerCopy, {
        incarnationId: service.incarnationId,
      }),
    ).toEqual(copy(2, [session(1)], 100));
    await run(null);
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(sync.timer_copy).toBeNull();
    // Removed, the fence stays: an earlier read still writes nothing.
    expect(await run(copy(1))).toMatchObject({
      value: { written: false },
    });
  });

  test("MU-10C-12 guards: another incarnation, an earlier epoch or a closing wipe writes nothing", async () => {
    const { t, service, seed } = await bound();
    const run = (over: Partial<ReturnType<AccountService["capture"]>>) =>
      service.store.run(writeTimerCopy, {
        captured: { ...service.capture(1), ...over },
        copy: copy(1),
      });
    expect(await run({ incarnationId: "x" })).toEqual({
      kind: "dropped",
      reason: "incarnation",
    });
    seed({ stamp: { epoch: 3 } });
    expect(await run({ epoch: 2 })).toEqual({
      kind: "dropped",
      reason: "epoch_superseded",
    });
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(sync.timer_copy ?? null).toBeNull();
  });

  test("the copy is bounded and read tolerantly; a lapsed quota hold writes nothing", async () => {
    const { service } = await bound();
    expect(
      parseTimerCopy(
        copy(
          1,
          Array.from({ length: TIMER_COPY_ROWS + 1 }, (_, i) => session(i)),
        ),
      ),
    ).toBeNull();
    expect(parseTimerCopy({ format: 2 })).toBeNull();
    // An order that does not read is 0: older than every ordered read (a corrected format-1 copy keeps it).
    expect(parseTimerCopy({ ...copy(1), order: -4 })?.order).toBe(0);
    expect(parseTimerCopy({ format: 3 })).toBeNull();
    expect(parseTimerCopy(undefined)).toBeNull();
    const out = await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: copy(5),
      leaseLive: () => false,
    });
    expect(out).toEqual({
      kind: "applied",
      value: { written: false, stored: null, lapsed: true },
    });
  });

  test("through the slice's commit: admitted through the quota ledger, then committed", async () => {
    const { t, service } = await bound();
    const out = await commitTimerCopy(t.env, service, service.capture(1), {
      ...copy(9),
    });
    expect(out).toEqual({ kind: "applied", value: { written: true } });
    const refused = await commitTimerCopy(
      {
        quota: {
          ...t.env.quota,
          reserve: async () =>
            ({
              verdict: "refuse",
              live: () => false,
              settle: () => undefined,
            }) as never,
        },
      },
      service,
      service.capture(1),
      copy(10),
    );
    expect(refused).toEqual({ kind: "dropped" });
    expect(
      await service.store.run(readTimerCopy, {
        incarnationId: service.incarnationId,
      }),
    ).toEqual(copy(9));
  });

  test("DA-T2: two reads are given distinct places in issue order, so a tie or a clock that went back decides nothing", async () => {
    const { service } = await bound();
    const issue = async () => {
      const out = await service.store.run(issueTimerOrder, {
        captured: service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const a = await issue();
    const b = await issue();
    expect(b).toBeGreaterThan(a);
    const run = (c: ReturnType<typeof copy>) =>
      service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: c,
      });
    // B (issued later, the SAME millisecond) lands first, saying nothing runs; A lands after it: refused.
    expect(await run(copy(b, [], 5_000))).toMatchObject({
      value: { written: true },
    });
    expect(await run(copy(a, [session(1)], 5_000))).toMatchObject({
      value: { written: false },
    });
    // A later read whose clock went BACK is still the later read.
    const c = await issue();
    expect(await run(copy(c, [session(2)], 10))).toMatchObject({
      value: { written: true },
    });
    // Another incarnation is given no place.
    expect(
      await service.store.run(issueTimerOrder, {
        captured: { ...service.capture(1), incarnationId: "x" },
      }),
    ).toEqual({ kind: "dropped", reason: "incarnation" });
  });

  test("a copy written before the order existed (format 1) reads as order 0 and the first ordered write replaces it", async () => {
    const { service, seed } = await bound();
    const legacy = {
      format: 1,
      read_at: 9_999_999_999_999,
      complete: true,
      running: [session(1)],
    };
    seed({ timer_copy: legacy });
    expect(parseTimerCopy(legacy)).toEqual({
      ...copy(0),
      read_at: legacy.read_at,
    });
    const out = await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: copy(1, []),
    });
    expect(out).toMatchObject({ value: { written: true } });
  });

  test("DA-T1: a day's correction removes what it names and fences out every earlier read; an earlier correction changes nothing", async () => {
    const { service } = await bound();
    const issue = async () => {
      const out = await service.store.run(issueTimerOrder, {
        captured: service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const account = await issue(); // an account read, its answer still on its way
    const first = await issue();
    await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: copy(first, [session(1), session(2)]),
    });
    const day = await issue();
    const correct = (order: number, id: string) =>
      service.store.run(reconcileTimerCopy, {
        captured: service.capture(1),
        order,
        drop: (row, newer) => newer && row.id === id,
      });
    expect(await correct(day, session(1).id)).toEqual({
      kind: "applied",
      value: { removed: 1, applied: true },
    });
    // The same read's later page (its traversal keeps its first page's place) may still correct.
    expect(await correct(day, session(2).id)).toEqual({
      kind: "applied",
      value: { removed: 1, applied: true },
    });
    // The account read issued before the correction lands now: refused, so the removed sessions are never restored (reload included).
    expect(
      await service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: copy(account, [session(1), session(2)]),
      }),
    ).toMatchObject({ value: { written: false } });
    expect(
      (
        await service.store.run(readTimerCopy, {
          incarnationId: service.incarnationId,
        })
      )?.running,
    ).toEqual([]);
    // A correction of an earlier order than the fence changes nothing.
    expect(await correct(first, session(1).id)).toEqual({
      kind: "applied",
      value: { removed: 0, applied: false },
    });
    // Control: a read issued after the correction replaces the copy normally.
    expect(
      await service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: copy(await issue(), [session(3)]),
      }),
    ).toMatchObject({ value: { written: true } });
  });
});

describe("W27: a task's discovery entry (revision 2, review R13 and DA-M1)", () => {
  const entry = (failures: number, stopped = false, retry = 0) => ({
    retry,
    failures,
    stop: stopped ? { reason: "unreachable" as const } : null,
  });
  test("a compare-and-set: written over the entry decided on, stale over another, removed on success; read back by task", async () => {
    const { service } = await bound();
    const write = (
      expected: ReturnType<typeof entry> | null,
      next: ReturnType<typeof entry> | null,
      task = TASK,
    ) =>
      service.store.run(writeMaterialiseDiscovery, {
        captured: service.capture(1),
        task_id: task,
        expected,
        next,
      });
    expect(await write(null, entry(1))).toEqual({
      kind: "applied",
      value: { kind: "written", stored: entry(1) },
    });
    // A late answer decided on the absent entry: stale, nothing written.
    expect(await write(null, entry(1))).toEqual({
      kind: "applied",
      value: { kind: "stale", stored: entry(1) },
    });
    expect(await write(entry(1), entry(3, true))).toMatchObject({
      value: { kind: "written" },
    });
    // "Try again" moves `retry`: an answer decided under the earlier budget (same counts, earlier retry) is stale.
    expect(await write(entry(3, true), entry(0, false, 1))).toMatchObject({
      value: { kind: "written" },
    });
    expect(await write(entry(0, false, 0), entry(1, false, 0))).toMatchObject({
      value: { kind: "stale" },
    });
    expect(
      await service.store.run(readMaterialiseDiscovery, {
        incarnationId: service.incarnationId,
      }),
    ).toEqual({ [TASK]: entry(0, false, 1) });
    expect(await write(entry(0, false, 1), null)).toMatchObject({
      value: { kind: "written", stored: null },
    });
    expect(
      await service.store.run(readMaterialiseDiscovery, {
        incarnationId: service.incarnationId,
      }),
    ).toEqual({});
  });

  test("bounded: one that would add a task beyond the window is refused (full); response-derived guards apply", async () => {
    const { service, seed } = await bound();
    const many: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i < SEQUENCE_WINDOW; i += 1)
      many[`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`] = entry(1);
    seed({ materialise_discovery: many });
    expect(
      await service.store.run(writeMaterialiseDiscovery, {
        captured: service.capture(1),
        task_id: OTHER_TASK,
        expected: null,
        next: entry(1),
      }),
    ).toEqual({ kind: "applied", value: { kind: "full", stored: null } });
    expect(
      await service.store.run(writeMaterialiseDiscovery, {
        captured: { ...service.capture(1), incarnationId: "x" },
        task_id: TASK,
        expected: null,
        next: entry(1),
      }),
    ).toEqual({ kind: "dropped", reason: "incarnation" });
  });
});

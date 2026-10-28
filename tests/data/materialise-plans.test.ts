// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AccountService } from "../../src/data/engine/account-service";
import type {
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../src/data/model/types";
import {
  deleteSatisfiedSequences,
  liftMaterialiseStops,
  readMaterialiseDiscovery,
  readMaterialiseSequence,
  readMaterialiseSequences,
  readTaskSequences,
  SEQUENCE_WINDOW,
  TASK_SEQUENCE_DAYS,
  TASK_SEQUENCE_ROWS,
  TASK_SEQUENCE_TASKS,
  type TaskSequencesAsk,
  writeMaterialiseDiscovery,
  writeMaterialiseSequence,
} from "../../src/data/plans/materialise";
import {
  issueTimerOrder,
  parseTimerCopy,
  readTimerAuthority,
  readTimerCopy,
  readTimerScope,
  reconcileTimerCopy,
  recordTimerEnded,
  TIMER_COPY_ROWS,
  TIMER_ENDED_IDS,
  TIMER_SCOPE_IDS,
  TIMER_SCOPES,
  writeTimerCopy,
} from "../../src/data/plans/timer-copy";
import {
  commitMaterialiseSequence,
  commitTimerCopy,
  commitTimerCorrection,
} from "../../src/data/ui/task-records";
import { expectationOf } from "../../src/features/tasks/model/materialise";
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
    // Revision 4 (review R20): the store stamps the revision (1 for a new row), and returns the row as written.
    expect(await write({ expected: null, next: row() })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: row({ revision: 1 }) },
    });
    expect(stored()).toEqual(row({ revision: 1 }));
    // MU-10C-11: a CAS that writes when stale overwrites another runner's sequence.
    const second = await write({
      expected: null,
      next: row({ sequence_generation: "g2" }),
    });
    expect(second).toEqual({
      kind: "applied",
      value: { kind: "stale", stored: row({ revision: 1 }) },
    });
    expect(stored()?.sequence_generation).toBe("g1");
  });

  test("a transition applies only to the row it was decided on: generation, phase, read sequence, attempt key and revision", async () => {
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
      revision: 1,
    };
    for (const wrong of [
      { ...expected, sequence_generation: "g0" },
      { ...expected, phase: "ready" as const },
      { ...expected, read_seq: 1 },
      { ...expected, attempt_key: "k0" },
      { ...expected, attempt_key: null },
      // Revision 4 (review R20): the same generation, phase, read and attempt at another revision is another row.
      { ...expected, revision: 0 },
      { ...expected, revision: 2 },
    ]) {
      const out = await write({
        expected: wrong,
        next: row({ phase: "awaiting_position_read", read_seq: 1 }),
      });
      expect(out).toEqual({
        kind: "applied",
        value: { kind: "stale", stored: { ...submitting, revision: 1 } },
      });
    }
    expect(stored()).toEqual({ ...submitting, revision: 1 });
    const moved = row({ phase: "awaiting_position_read", read_seq: 1 });
    expect(await write({ expected, next: moved })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: { ...moved, revision: 2 } },
    });
    expect(stored()).toEqual({ ...moved, revision: 2 });
  });

  test("an expectation of a row that is gone is stale (absent), and a delete removes the row", async () => {
    const { write, stored } = await bound();
    const expected = {
      sequence_generation: "g1",
      phase: "ready" as const,
      read_seq: 0,
      attempt_key: null,
      revision: 1,
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
        revision: 1,
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
      value: { kind: "written", stored: row({ revision: 1 }) },
    });
    service.dispose("identity");
    const late = await commitMaterialiseSequence(service, service.capture(1), {
      key: { task_id: TASK, through_date: "2026-10-25" },
      expected: {
        sequence_generation: "g1",
        phase: "ready",
        read_seq: 0,
        attempt_key: null,
        revision: 1,
      },
      next: null,
    });
    expect(late.kind).not.toBe("applied");
    expect(stored()).toEqual(row({ revision: 1 }));
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

  /**
   * Adaptation (revision 5, reviews R24/R25, WEB-04 §5.8): this case asserted that beginning a later day PRUNED the task's earlier stopped
   * and ready rows. That deleted unsatisfied stops (R25). Its intent (housekeeping is bounded, never touches a running row it was not
   * told about, another task's or a row another page changed) is kept for the plan that replaces it, which removes only rows the caller
   * established satisfied, each only while it is still the row decided on.
   */
  test("satisfied rows are removed only as decided on: a stale expectation, an unnamed row and another task's stay", async () => {
    const { t, service } = await bound();
    const rows = [
      row({
        through_date: "2026-10-20",
        phase: "stopped",
        stop: { reason: "bound" },
      }),
      row({ through_date: "2026-10-21", phase: "ready" }),
      row({
        through_date: "2026-10-22",
        phase: "submitting",
        attempt: { key: "k", body: "b" },
      }),
      row({ through_date: "2026-10-23", phase: "awaiting_position_read" }),
      row({
        through_date: "2026-10-25",
        phase: "stopped",
        stop: { reason: "no_progress" },
      }),
      row({ task_id: OTHER_TASK, through_date: "2026-10-20" }),
    ];
    t.world.idb.seed(DB, "materialise_sequences", rows);
    const as = (r: MaterialiseSequenceRow) =>
      expectationOf(r) as Exclude<ReturnType<typeof expectationOf>, null>;
    const out = await service.store.run(deleteSatisfiedSequences, {
      captured: service.capture(1),
      task_id: TASK,
      rows: [
        {
          through_date: "2026-10-20",
          expected: as(rows[0] as MaterialiseSequenceRow),
        },
        {
          through_date: "2026-10-22",
          expected: as(rows[2] as MaterialiseSequenceRow),
        },
        // Another page lifted it since (its revision moved): it stays.
        {
          through_date: "2026-10-23",
          expected: { ...as(rows[3] as MaterialiseSequenceRow), revision: 4 },
        },
        // Absent: nothing to remove.
        {
          through_date: "2026-10-19",
          expected: as(rows[0] as MaterialiseSequenceRow),
        },
      ],
    });
    expect(out).toEqual({ kind: "applied", value: { removed: 2 } });
    const left = await service.store.run(readMaterialiseSequences, {
      incarnationId: service.incarnationId,
      taskId: null,
    });
    expect(left.map((r) => `${r.task_id.slice(-1)}:${r.through_date}`)).toEqual(
      ["1:2026-10-21", "1:2026-10-23", "1:2026-10-25", "2:2026-10-20"],
    );
    await expect(
      service.store.run(deleteSatisfiedSequences, {
        captured: service.capture(1),
        task_id: TASK,
        rows: Array.from({ length: SEQUENCE_WINDOW + 1 }, () => ({
          through_date: "2026-10-21",
          expected: as(rows[1] as MaterialiseSequenceRow),
        })),
      }),
    ).rejects.toThrow();
  });

  test("a NEW row is admitted (revision 5): not admitted, nothing is written; replacing a row needs no admission", async () => {
    const { t, service } = await bound();
    const key = { task_id: TASK, through_date: "2026-10-25" };
    const write = (over: Record<string, unknown>) =>
      service.store.run(writeMaterialiseSequence, {
        captured: service.capture(1),
        key,
        expected: null,
        next: row(),
        ...over,
      });
    expect(await write({ admitted: false })).toEqual({
      kind: "applied",
      value: { kind: "refused", stored: null },
    });
    expect(await write({ leaseLive: () => false })).toEqual({
      kind: "applied",
      value: { kind: "refused", stored: null },
    });
    expect(
      t.world.idb.peek(DB, "materialise_sequences", [TASK, "2026-10-25"]),
    ).toBeUndefined();
    const made = await write({ leaseLive: () => true });
    expect(made).toMatchObject({ value: { kind: "written" } });
    const stored = t.world.idb.peek(DB, "materialise_sequences", [
      TASK,
      "2026-10-25",
    ]) as MaterialiseSequenceRow;
    expect(
      await service.store.run(writeMaterialiseSequence, {
        captured: service.capture(1),
        key,
        expected: expectationOf(stored),
        next: { ...stored, phase: "stopped", stop: { reason: "bound" } },
        admitted: false,
      }),
    ).toMatchObject({ value: { kind: "written" } });
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

  test("DA-T1: a day's correction removes what it names and fences out every earlier read; an earlier correction removes only what its own order entitles it to", async () => {
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
      value: { removed: 1, applied: true, scoped: false },
    });
    // The same read's later page (its traversal keeps its first page's place) may still correct.
    expect(await correct(day, session(2).id)).toEqual({
      kind: "applied",
      value: { removed: 1, applied: true, scoped: false },
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
    // A correction of an earlier order than the fence: revision 3 asserted it was not applied at all (`applied: false`). Revision 4 (review
    // R19): the fence is the latest order of ANY read, so a correction is judged against the copy's own order instead; one no later than
    // the copy decides nothing by absence (`newer` false), removes nothing here, and never moves the fence back.
    await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: copy(await issue(), [session(1)]),
    });
    expect(await correct(first, session(1).id)).toEqual({
      kind: "applied",
      value: { removed: 0, applied: true, scoped: false },
    });
    expect(
      (
        await service.store.run(readTimerCopy, {
          incarnationId: service.incarnationId,
        })
      )?.running,
    ).toEqual([session(1)]);
    expect(
      await service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: copy(day, [session(1), session(2)]),
      }),
    ).toMatchObject({ value: { written: false } });
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

  /**
   * Revision 3 (review R16): this case asserted a FIXED cap of `SEQUENCE_WINDOW` entries (`full`): the very limit that lost a stop across
   * a reload. Its intent, "the discovery record is bounded and its response-derived guards apply", is kept over admission: a NEW task's
   * entry is written only when the quota ledger admitted its growth (refused, or a lapsed hold: `refused`, nothing written), however many
   * entries exist (here more than the old window); replacing an entry needs no admission (its size was admitted); the guards apply.
   */
  test("admitted, not capped: a new task's entry needs the ledger's admission (refused or lapsed: nothing written), at any count; guards apply", async () => {
    const { service, seed } = await bound();
    const many: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i <= SEQUENCE_WINDOW; i += 1)
      many[`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`] = entry(1);
    seed({ materialise_discovery: { ...many, [TASK]: entry(1) } });
    const add = (over: { admitted?: boolean; leaseLive?: () => boolean }) =>
      service.store.run(writeMaterialiseDiscovery, {
        captured: service.capture(1),
        task_id: OTHER_TASK,
        expected: null,
        next: entry(1),
        ...over,
      });
    expect(await add({ admitted: false })).toEqual({
      kind: "applied",
      value: { kind: "refused", stored: null },
    });
    expect(await add({ leaseLive: () => false })).toEqual({
      kind: "applied",
      value: { kind: "refused", stored: null },
    });
    expect(await add({ leaseLive: () => true })).toEqual({
      kind: "applied",
      value: { kind: "written", stored: entry(1) },
    });
    // Replacing a stored entry (its outcome) is not growth: no admission asked.
    expect(
      await service.store.run(writeMaterialiseDiscovery, {
        captured: service.capture(1),
        task_id: TASK,
        expected: entry(1),
        next: entry(2),
        admitted: false,
      }),
    ).toEqual({
      kind: "applied",
      value: { kind: "written", stored: entry(2) },
    });
    expect(
      await service.store.run(writeMaterialiseDiscovery, {
        captured: { ...service.capture(1), incarnationId: "x" },
        task_id: TASK,
        expected: null,
        next: entry(1),
      }),
    ).toEqual({ kind: "dropped", reason: "incarnation" });
  });

  test("an answer is recorded only over its own admitted attempt: another attempt, or an entry deleted and made again, is stale", async () => {
    const { service, seed } = await bound();
    const mine = { ...entry(1), attempt: "attempt-a" };
    seed({
      materialise_discovery: { [TASK]: { ...entry(1), attempt: "attempt-b" } },
    });
    const write = (expected: object | null, next: object | null) =>
      service.store.run(writeMaterialiseDiscovery, {
        captured: service.capture(1),
        task_id: TASK,
        expected: expected as never,
        next: next as never,
      });
    // Another page re-admitted the read (attempt b): a's answer (its count, its success) changes nothing.
    expect(
      await write(mine, { ...entry(2), attempt: "attempt-c" }),
    ).toMatchObject({
      value: { kind: "stale", stored: { attempt: "attempt-b" } },
    });
    expect(await write(mine, null)).toMatchObject({ value: { kind: "stale" } });
    // Deleted (b's success), then made again by a new admission: still not a's.
    expect(
      await write({ ...entry(1), attempt: "attempt-b" }, null),
    ).toMatchObject({
      value: { kind: "written", stored: null },
    });
    expect(
      await write(null, { ...entry(0), attempt: "attempt-d" }),
    ).toMatchObject({
      value: { kind: "written" },
    });
    expect(await write(mine, null)).toMatchObject({ value: { kind: "stale" } });
    // An entry of revision 2 (no attempt) is read and compared as attempt null: its stop and count are kept.
    seed({ materialise_discovery: { [TASK]: entry(3, true) } });
    expect(
      await write(entry(3, true), { ...entry(0), retry: 1 }),
    ).toMatchObject({
      value: { kind: "written" },
    });
  });
});

/**
 * Revision 3 (review R14, design assessment DA-T3): a day's read records what it observed of its day (its scope) under the day's OWN
 * order, whatever the copy's fence; bounded, and whatever is not kept raises the floor instead (never dropped silently).
 */
describe("W28: what a day's reads observed (revision 3, DA-T3)", () => {
  const DAY = "aaaaaaaa-0000-4000-8000-0000000000d1";
  const id = (n: number) =>
    `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seen = (
    running: string[],
    ended: string[] = [],
    complete = true,
    day = DAY,
  ) => ({ occurrence_id: day, complete, running, ended });
  async function scoped() {
    const b = await bound();
    const issue = async () => {
      const out = await b.service.store.run(issueTimerOrder, {
        captured: b.service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const observe = (
      order: number,
      scope: ReturnType<typeof seen>,
      over: { admitted?: boolean; leaseLive?: () => boolean } = {},
    ) =>
      b.service.store.run(reconcileTimerCopy, {
        captured: b.service.capture(1),
        order,
        drop: () => false,
        scope,
        ...over,
      });
    const read = async (day = DAY) =>
      b.service.store.run(readTimerScope, {
        incarnationId: b.service.incarnationId,
        occurrenceId: day,
      });
    return { ...b, issue, observe, read };
  }

  test("recorded under the day's own order even when the copy's fence is later; later pages of one read merge; an earlier complete read never replaces a later one", async () => {
    const { service, issue, observe, read } = await scoped();
    const day = await issue();
    // An account read issued after it lands first: the copy's fence passes the day's read.
    await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: {
        format: 2,
        order: await issue(),
        read_at: 1,
        complete: false,
        running: [],
      },
    });
    // Revision 4 (review R19): the copy is corrected whatever the fence (`applied`; revision 3 asserted `false` here); its scope is
    // recorded under the day's own order either way.
    expect(await observe(day, seen([], [id(1)], false))).toMatchObject({
      value: { applied: true, removed: 0, scoped: true },
    });
    expect(await read()).toEqual({
      scope: {
        seen: day,
        order: 0,
        running: [],
        ended: [id(1)],
        ended_at: day,
      },
      floor: 0,
      through: 0,
    });
    // The same read's last page completes it: its running list is the day's.
    await observe(day, seen([id(2)], [id(1)], true));
    expect((await read()).scope).toEqual({
      seen: day,
      order: day,
      running: [id(2)],
      ended: [],
      ended_at: 0,
    });
    const later = await issue();
    await observe(later, seen([], [], true));
    // An earlier complete read arriving late changes nothing it would contradict.
    await observe(day, seen([id(3)], [], true));
    expect((await read()).scope).toMatchObject({
      seen: later,
      order: later,
      running: [],
    });
  });

  test("another day's observation is its own; a scope decides only for its day", async () => {
    const { issue, observe, read } = await scoped();
    const other = "aaaaaaaa-0000-4000-8000-0000000000d2";
    await observe(await issue(), seen([], [], true, other));
    expect((await read()).scope).toBeNull();
    expect((await read(other)).scope).toMatchObject({ running: [] });
  });

  test(`at most ${TIMER_SCOPES} days: the one seen longest ago goes, and its order becomes the floor`, async () => {
    const { issue, observe, read } = await scoped();
    const first = await issue();
    await observe(first, seen([], [], true));
    for (let i = 0; i < TIMER_SCOPES; i += 1)
      await observe(
        await issue(),
        seen(
          [],
          [],
          true,
          `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      );
    expect(await read()).toEqual({ scope: null, floor: first, through: 0 });
  });

  test(`a list beyond ${TIMER_SCOPE_IDS} sessions is not kept: the floor rises to that read's order instead`, async () => {
    const { issue, observe, read } = await scoped();
    const many = Array.from({ length: TIMER_SCOPE_IDS + 1 }, (_, i) => id(i));
    const order = await issue();
    await observe(order, seen([], many, false));
    expect(await read()).toEqual({
      scope: { seen: order, order: 0, running: [], ended: [], ended_at: 0 },
      floor: order,
      through: 0,
    });
  });

  test("growth the quota ledger refused, or a hold that lapsed, is not recorded: the floor rises and the copy is still corrected", async () => {
    const { t, service, issue, observe, read } = await scoped();
    const a = await issue();
    expect(
      await observe(a, seen([], [], true), { leaseLive: () => false }),
    ).toMatchObject({ value: { applied: true, scoped: false } });
    expect(await read()).toEqual({ scope: null, floor: a, through: 0 });
    await service.store.run(writeTimerCopy, {
      captured: service.capture(1),
      copy: {
        format: 2,
        order: await issue(),
        read_at: 1,
        complete: true,
        running: [{ id: id(9), occurrence_id: DAY }],
      },
    });
    const b = await issue();
    const refused = await commitTimerCorrection(
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
      {
        order: b,
        drop: (row) => row.id === id(9),
        scope: seen([], [id(9)], true),
      },
    );
    expect(refused).toEqual({
      kind: "applied",
      value: { removed: 1, applied: true, scoped: false },
    });
    // Its finished session was not kept either: lost THROUGH b (revision 6, R27), not only below it.
    expect(await read()).toEqual({ scope: null, floor: b, through: b });
    // Admitted (the ledger of the world), it is recorded.
    const c = await issue();
    expect(
      await commitTimerCorrection(t.env, service, service.capture(1), {
        order: c,
        drop: () => false,
        scope: seen([id(4)], [], true),
      }),
    ).toMatchObject({ value: { scoped: true } });
    expect((await read()).scope).toMatchObject({ order: c, running: [id(4)] });
  });

  test("a stored scope that does not read raises the floor to what it had seen, or to every order handed out", async () => {
    const { seed, read, issue } = await scoped();
    await issue();
    await issue();
    seed({ timer_scopes: { [DAY]: { seen: 2, order: "x" } } });
    expect(await read()).toEqual({ scope: null, floor: 2, through: 0 });
    seed({ timer_scopes: { [DAY]: "damaged" }, timer_order: 7 });
    expect(await read()).toEqual({ scope: null, floor: 7, through: 0 });
  });
});

/**
 * Revision 4 (review R20): "Try again" over the stops it was pressed on, as ONE compare-and-set; and the row's revision, which every W27
 * write moves, so a stop that returns to the same generation, phase, read and attempt is still another row.
 */
describe("W27: the revision and the lift (revision 4, review R20)", () => {
  const stoppedRow = (over: Partial<MaterialiseSequenceRow> = {}) =>
    row({
      phase: "stopped",
      attempt: { key: "k1", body: "{}" },
      read_failures: 3,
      stop: { reason: "unreachable" },
      ...over,
    });
  const expectOf = (r: MaterialiseSequenceRow) => ({
    sequence_generation: r.sequence_generation,
    phase: r.phase,
    read_seq: r.read_seq,
    attempt_key: r.attempt?.key ?? null,
    revision: r.revision ?? 0,
  });
  const lifted = (r: MaterialiseSequenceRow) => ({
    ...r,
    phase: "submitting" as const,
    read_failures: 0,
    successful_calls: 0,
    stop: null,
  });
  const ENTRY = {
    retry: 2,
    failures: 3,
    stop: { reason: "unreachable" as const },
    attempt: "a1",
  };
  const NEXT = { retry: 3, failures: 0, stop: null, attempt: null };

  test("every write moves the revision; a row of an earlier build (none) is matched as 0 and written as 1; one that cannot move is refused", async () => {
    const { t, write, stored } = await bound();
    t.world.idb.seed(DB, "materialise_sequences", [stoppedRow()]);
    const legacy = stored() as MaterialiseSequenceRow;
    expect(legacy.revision).toBeUndefined();
    const out = await write({
      expected: expectOf(legacy),
      next: lifted(legacy),
    });
    expect(out.kind === "applied" && out.value.kind).toBe("written");
    expect(stored()?.revision).toBe(1);
    // The same transition decided on the legacy row again (another tab's press of the same stop) is stale.
    expect(
      await write({ expected: expectOf(legacy), next: lifted(legacy) }),
    ).toMatchObject({ value: { kind: "stale" } });
    const one = stored() as MaterialiseSequenceRow;
    await write({ expected: expectOf(one), next: stoppedRow() });
    expect(stored()?.revision).toBe(2);
    // An unreadable revision reads as 0 on both sides; a revision at the end of its range is never overwritten.
    t.world.idb.seed(DB, "materialise_sequences", [
      stoppedRow({ revision: "x" as never }),
    ]);
    const odd = stored() as MaterialiseSequenceRow;
    await write({ expected: expectOf(odd), next: lifted(odd) });
    expect(stored()?.revision).toBe(1);
    t.world.idb.seed(DB, "materialise_sequences", [
      stoppedRow({ revision: Number.MAX_SAFE_INTEGER }),
    ]);
    const last = stored() as MaterialiseSequenceRow;
    expect(
      await write({ expected: expectOf(last), next: lifted(last) }),
    ).toMatchObject({ value: { kind: "stale" } });
    expect(stored()?.phase).toBe("stopped");
  });

  test("a lift writes both stops or neither: a stale discovery leaves the sequence stopped; a stale sequence leaves the discovery stopped", async () => {
    const { t, service, seed, stored } = await bound();
    const sequence = stoppedRow({ revision: 4 });
    t.world.idb.seed(DB, "materialise_sequences", [sequence]);
    seed({ materialise_discovery: { [TASK]: ENTRY } });
    const entry = () =>
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .materialise_discovery?.[TASK];
    const lift = (
      discovery: typeof ENTRY | null,
      seq: MaterialiseSequenceRow | null,
    ) =>
      service.store.run(liftMaterialiseStops, {
        captured: service.capture(1),
        task_id: TASK,
        discovery:
          discovery === null
            ? { kind: "no_stop" as const }
            : { kind: "stopped" as const, expected: discovery, next: NEXT },
        sequence:
          seq === null
            ? null
            : {
                key: { task_id: TASK, through_date: seq.through_date },
                expected: expectOf(seq),
                next: lifted(seq),
              },
      });
    // Stale discovery (another retry generation): nothing written.
    expect(await lift({ ...ENTRY, retry: 1 }, sequence)).toEqual({
      kind: "applied",
      value: { kind: "stale" },
    });
    expect(stored()).toEqual(sequence);
    expect(entry()).toEqual(ENTRY);
    // Stale sequence (an earlier revision of the same stop): nothing written, the discovery kept.
    expect(await lift(ENTRY, { ...sequence, revision: 3 })).toEqual({
      kind: "applied",
      value: { kind: "stale" },
    });
    expect(stored()).toEqual(sequence);
    expect(entry()).toEqual(ENTRY);
    // A discovery the map does not hold is never ADDED by a lift.
    expect(
      await service.store.run(liftMaterialiseStops, {
        captured: service.capture(1),
        task_id: OTHER_TASK,
        discovery: { kind: "stopped", expected: ENTRY, next: NEXT },
        sequence: null,
      }),
    ).toEqual({ kind: "applied", value: { kind: "stale" } });
    // Both as seen: both lifted at once, the revision moved.
    expect(await lift(ENTRY, sequence)).toEqual({
      kind: "applied",
      value: { kind: "written" },
    });
    expect(entry()).toEqual(NEXT);
    expect(stored()).toEqual({ ...lifted(sequence), revision: 5 });
    // Pressed again on what it saw: stale, nothing more.
    expect(await lift(ENTRY, sequence)).toMatchObject({
      value: { kind: "stale" },
    });
  });

  /**
   * Revision 6 (review 6 R30): the press's expectation of the discovery is compared even when nothing of it is replaced: `no_stop` (the
   * screen showed none) is stale once a stop stands, and the sequence is not lifted beside it; an entry still working (no stop) is not one.
   */
  test.each([
    [
      "a stopped discovery entry now stands: stale, nothing written",
      "stopped",
      "stale",
    ],
    [
      "an entry still working (no stop): the sequence is lifted",
      "working",
      "written",
    ],
    ["no entry (control): the sequence is lifted", "none", "written"],
  ])("no_stop expected; %s", async (_, entry, outcome) => {
    const { t, service, seed, stored } = await bound();
    const sequence = stoppedRow({ revision: 4 });
    t.world.idb.seed(DB, "materialise_sequences", [sequence]);
    if (entry !== "none")
      seed({
        materialise_discovery: {
          [TASK]: entry === "stopped" ? ENTRY : { ...ENTRY, stop: null },
        },
      });
    const before = (
      t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow
    ).materialise_discovery;
    expect(
      await service.store.run(liftMaterialiseStops, {
        captured: service.capture(1),
        task_id: TASK,
        discovery: { kind: "no_stop" },
        sequence: {
          key: { task_id: TASK, through_date: sequence.through_date },
          expected: expectOf(sequence),
          next: lifted(sequence),
        },
      }),
    ).toEqual({ kind: "applied", value: { kind: outcome } });
    expect(stored()).toEqual(
      outcome === "stale" ? sequence : { ...lifted(sequence), revision: 5 },
    );
    expect(
      (t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow)
        .materialise_discovery,
    ).toEqual(before);
  });
});

/** Revision 4 (review R21): the latest day of each NAMED task, whatever other tasks' rows sort before it; bounded per read. */
/**
 * Adaptation (revision 5, review R24): revision 4 read only the LATEST day of each task (R21), which let a later day (a horizon stop) hide
 * the day a screen works for. Its intent (a task's rows are found whatever other tasks hold, bounded per read) is kept; the read now also
 * returns the exact day asked for and the task's latest days with whether they are all of them.
 */
describe("W27: the recovery rows by task (revision 5, review R24; revision 4, R21)", () => {
  test("the exact day past any number of other tasks' rows and of its own later days; the latest days, complete or not; bounded per read", async () => {
    const { t, service } = await bound();
    const others = Array.from({ length: SEQUENCE_WINDOW + 1 }, (_, i) =>
      row({
        task_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        phase: "stopped",
        stop: { reason: "bound" },
      }),
    );
    const days = Array.from({ length: SEQUENCE_WINDOW + 20 }, (_, i) =>
      row({
        through_date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      }),
    );
    t.world.idb.seed(DB, "materialise_sequences", [...others, ...days]);
    const sorted = [...days].sort((a, b) =>
      a.through_date < b.through_date ? -1 : 1,
    );
    const target = sorted[3] as MaterialiseSequenceRow;
    const read = (tasks: Array<{ taskId: string; throughDate?: string }>) =>
      service.store.run(readTaskSequences, {
        incarnationId: service.incarnationId,
        tasks,
      });
    const found = await read([
      { taskId: TASK, throughDate: target.through_date },
      { taskId: OTHER_TASK, throughDate: "2026-10-25" },
    ]);
    expect(found[TASK]?.target).toEqual(target);
    expect(found[TASK]?.rows).toEqual(sorted.slice(-TASK_SEQUENCE_ROWS));
    expect(found[TASK]?.complete).toBe(false);
    // Absent: the day asked for is known absent (null), and a task with no rows is complete.
    expect(found[OTHER_TASK]).toEqual({
      target: null,
      rows: [],
      complete: true,
    });
    // Not asked for a day: none is named.
    expect((await read([{ taskId: TASK }]))[TASK]?.target).toBeUndefined();
    expect(Object.keys(await read([]))).toEqual([]);
    const ids = others.map((r) => ({ taskId: r.task_id }));
    expect(
      Object.keys(await read(ids.slice(0, TASK_SEQUENCE_TASKS))),
    ).toHaveLength(TASK_SEQUENCE_TASKS);
    await expect(read(ids.slice(0, TASK_SEQUENCE_TASKS + 1))).rejects.toThrow();
  });
});

/** Revision 4 (review R19): the copy, every scope and the floor in one read; corrections of one day are not fenced by another's. */
describe("W28: one authority (revision 4, review R19)", () => {
  const A = "aaaaaaaa-0000-4000-8000-0000000000d1";
  const B = "aaaaaaaa-0000-4000-8000-0000000000d2";
  const S = "cccccccc-0000-4000-8000-000000000001";
  const seenOf = (day: string, running: string[] = []) => ({
    occurrence_id: day,
    complete: true,
    running,
    ended: [],
  });
  async function world() {
    const b = await bound();
    const issue = async () => {
      const out = await b.service.store.run(issueTimerOrder, {
        captured: b.service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const correct = (order: number, day: string) =>
      b.service.store.run(reconcileTimerCopy, {
        captured: b.service.capture(1),
        order,
        drop: (r, newer) => newer && r.occurrence_id === day,
        scope: seenOf(day),
      });
    const authority = () =>
      b.service.store.run(readTimerAuthority, {
        incarnationId: b.service.incarnationId,
      });
    return { ...b, issue, correct, authority };
  }

  test.each([
    ["after another day's later read", true],
    ["alone (control)", false],
  ])(
    "REVIEW4 T5 at the plan: a day's earlier complete read landing %s still corrects the older copy; the fence never moves back",
    async (_, overtaken) => {
      const { service, issue, correct, authority } = await world();
      const copyAt = await issue();
      await service.store.run(writeTimerCopy, {
        captured: service.capture(1),
        copy: {
          format: 2,
          order: copyAt,
          read_at: 1,
          complete: true,
          running: [{ id: S, occurrence_id: A }],
        },
      });
      const first = await issue();
      // An account read issued between the two day reads, its answer still on its way.
      const account = await issue();
      const later = await issue();
      if (overtaken) await correct(later, B);
      expect(await correct(first, A)).toMatchObject({
        value: { removed: 1, applied: true, scoped: true },
      });
      const now = await authority();
      expect(now.copy?.running).toEqual([]);
      expect(now.scopes[A]?.order).toBe(first);
      // The account read issued before the later read still cannot replace the copy: the fence never moves back.
      expect(
        await service.store.run(writeTimerCopy, {
          captured: service.capture(1),
          copy: {
            format: 2,
            order: overtaken ? account : first,
            read_at: 1,
            complete: true,
            running: [{ id: S, occurrence_id: A }],
          },
        }),
      ).toMatchObject({ value: { written: false } });
    },
  );

  test("one snapshot: the copy, every readable scope, and a floor raised by every scope or map that does not read", async () => {
    const { service, seed, issue, correct, authority } = await world();
    const a = await issue();
    await correct(a, A);
    const b = await issue();
    await correct(b, B);
    expect(await authority()).toMatchObject({
      copy: null,
      floor: 0,
      scopes: { [A]: { order: a }, [B]: { order: b } },
    });
    // One scope that does not read: its own `seen` is lost.
    seed({
      timer_scopes: {
        [A]: { seen: a, order: a, running: [], ended: [], ended_at: 0 },
        [B]: { seen: b, order: "x" },
      },
    });
    const one = await authority();
    expect(Object.keys(one.scopes)).toEqual([A]);
    expect(one.floor).toBe(b);
    // A map that is not a map: every order handed out so far.
    seed({ timer_scopes: "lost" as never, timer_order: 9 });
    expect(await authority()).toMatchObject({ scopes: {}, floor: 9 });
    // A correction over it keeps that loss (the floor) while it records the new day.
    const c = await issue();
    await correct(c, A);
    const after = await authority();
    expect(after.scopes[A]?.order).toBe(c);
    expect(after.floor).toBeGreaterThanOrEqual(9);
    expect(
      (
        await service.store.run(readTimerScope, {
          incarnationId: service.incarnationId,
          occurrenceId: A,
        })
      ).floor,
    ).toBe(after.floor);
  });
});

/**
 * Revision 5 (review 5 R23): the account's latest complete observation is kept apart from the copy, and every session a read listed
 * finished is kept (bounded, its loss recorded), so a later partial page, going offline or a reload never brings one back.
 */
describe("W28: the complete account observation and finished sessions (revision 5, review R23)", () => {
  const S = "cccccccc-0000-4000-8000-0000000000e1";
  const U = "cccccccc-0000-4000-8000-0000000000e2";
  async function world() {
    const b = await bound();
    const issue = async () => {
      const out = await b.service.store.run(issueTimerOrder, {
        captured: b.service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const copy = async (complete: boolean, running: object[]) =>
      b.service.store.run(writeTimerCopy, {
        captured: b.service.capture(1),
        copy: {
          format: 2,
          order: await issue(),
          read_at: 1,
          complete,
          running: running as never,
        },
      });
    const authority = () =>
      b.service.store.run(readTimerAuthority, {
        incarnationId: b.service.incarnationId,
      });
    const sync = () =>
      b.t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow;
    return { ...b, issue, copy, authority, sync };
  }

  test("a complete copy is the account's observation; a later partial one replaces the copy, never the observation; a row naming no session records none", async () => {
    const w = await world();
    await w.copy(true, [{ id: S }, { id: U }]);
    const first = (await w.authority()).account;
    expect(first).toEqual({ order: expect.any(Number), running: [S, U] });
    await w.copy(false, [{ id: U }]);
    expect((await w.authority()).account).toEqual(first);
    expect((await w.authority()).copy?.complete).toBe(false);
    await w.copy(true, [{ id: U }, { name: "no id" }]);
    expect(
      (await w.authority()).account,
      "what it listed is not known",
    ).toEqual(first);
    await w.copy(true, []);
    expect((await w.authority()).account?.running).toEqual([]);
  });

  test("history's finished sessions are recorded and taken out of the copy; refused, the copy loses them and the loss is recorded at every order issued", async () => {
    const w = await world();
    await w.copy(true, [{ id: S }, { id: U }]);
    const recorded = await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: [S, S, 42 as never],
      leaseLive: () => true,
    });
    expect(recorded).toEqual({
      kind: "applied",
      value: { recorded: true, removed: 1 },
    });
    expect((await w.authority()).ended).toEqual([S]);
    expect((await w.authority()).copy?.running).toEqual([{ id: U }]);
    expect((await w.authority()).endedLost).toBe(false);
    const issued = await w.issue();
    const refused = await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: [U],
      admitted: false,
    });
    expect(refused).toEqual({
      kind: "applied",
      value: { recorded: false, removed: 1 },
    });
    const after = await w.authority();
    expect(after.ended).toEqual([S]);
    expect(after.endedLost).toBe(true);
    expect(after.floor).toBeGreaterThanOrEqual(issued);
    expect(after.copy?.running).toEqual([]);
    // An answer of another database incarnation records nothing.
    expect(
      await w.service.store.run(recordTimerEnded, {
        captured: { ...w.service.capture(1), incarnationId: "x" },
        ids: ["cccccccc-0000-4000-8000-0000000000e3"],
      }),
    ).toEqual({ kind: "dropped", reason: "incarnation" });
    expect((await w.authority()).ended).toEqual([S]);
  });

  test("beyond the bound the one recorded longest ago goes: the floor rises to the order handed out when it was recorded, and the loss is recorded", async () => {
    const w = await world();
    const firstAt = await w.issue();
    await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: ["first"],
    });
    for (let i = 0; i < TIMER_ENDED_IDS - 1; i += 1)
      await w.service.store.run(recordTimerEnded, {
        captured: w.service.capture(1),
        ids: [`s${i}`],
      });
    let now = await w.authority();
    expect(now.ended).toHaveLength(TIMER_ENDED_IDS);
    expect(now.endedLost).toBe(false);
    const floorBefore = now.floor;
    await w.issue();
    await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: ["last"],
    });
    now = await w.authority();
    expect(now.ended).toHaveLength(TIMER_ENDED_IDS);
    expect(now.ended).not.toContain("first");
    expect(now.ended).toContain("last");
    expect(now.endedLost).toBe(true);
    expect(now.floor).toBe(Math.max(floorBefore, firstAt));
  });

  test("a day's read records the sessions it listed finished for the account too; a record that does not read loses every order issued", async () => {
    const w = await world();
    const order = await w.issue();
    await w.service.store.run(reconcileTimerCopy, {
      captured: w.service.capture(1),
      order,
      drop: () => false,
      scope: { occurrence_id: "day", complete: false, running: [], ended: [S] },
    });
    expect((await w.authority()).ended).toEqual([S]);
    w.seed({ timer_ended: "damaged" as never, timer_order: 7 });
    const lost = await w.authority();
    expect(lost.ended).toEqual([]);
    expect(lost.endedLost).toBe(true);
    expect(lost.floor).toBeGreaterThanOrEqual(7);
    w.seed({
      timer_ended: undefined as never,
      timer_account: { order: "x" } as never,
      timer_order: 9,
    });
    expect((await w.authority()).floor).toBeGreaterThanOrEqual(9);
  });
});

/**
 * Revision 6 (review 6 R27): a lost FINISHED session is lost through the high-water when it was recorded, INCLUSIVELY (`endedThrough`),
 * whatever path lost it: the history's refused growth, eviction from the bound, a day read's refused scope (at the high-water, not the day
 * read's own order: a later running read may be in flight). A lost complete observation stays exclusive (the floor), and a record written
 * before revision 6, or one that does not read, is settled once by the next order issued.
 */
describe("W28: terminal loss is inclusive and covers every order issued (revision 6, review R27)", () => {
  const S = "cccccccc-0000-4000-8000-0000000000f1";
  async function world() {
    const b = await bound();
    const issue = async () => {
      const out = await b.service.store.run(issueTimerOrder, {
        captured: b.service.capture(1),
      });
      if (out.kind !== "applied") throw new Error("not applied");
      return out.value.order as number;
    };
    const authority = () =>
      b.service.store.run(readTimerAuthority, {
        incarnationId: b.service.incarnationId,
      });
    const sync = () =>
      b.t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow;
    return { ...b, issue, authority, sync };
  }

  test("refused history growth: lost THROUGH every order issued (the latest included), and the exclusive floor too for an older tab", async () => {
    const w = await world();
    await w.issue();
    const n = await w.issue();
    expect((await w.authority()).endedThrough).toBe(0);
    await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: [S],
      admitted: false,
    });
    const after = await w.authority();
    expect(after).toMatchObject({ endedLost: true, endedThrough: n });
    expect(after.floor).toBe(n);
    expect(w.sync().timer_ended).toEqual({ lost: true, ids: [], through: n });
    // A later read is trusted: its order is above the bound.
    expect(await w.issue()).toBeGreaterThan(n);
  });

  test("eviction: lost through the order the evicted session was recorded at; one recorded later is not", async () => {
    const w = await world();
    const firstAt = await w.issue();
    await w.service.store.run(recordTimerEnded, {
      captured: w.service.capture(1),
      ids: ["first"],
    });
    const laterAt = await w.issue();
    for (let i = 0; i < TIMER_ENDED_IDS; i += 1)
      await w.service.store.run(recordTimerEnded, {
        captured: w.service.capture(1),
        ids: [`s${i}`],
      });
    const now = await w.authority();
    expect(now.ended).not.toContain("first");
    expect(now.endedThrough).toBe(firstAt);
    expect(now.endedThrough).toBeLessThan(laterAt);
  });

  test.each([
    ["a finished session", [S], true],
    [
      "nothing finished (control): absence only, exclusive at the day read",
      [],
      false,
    ],
  ])(
    "a day read at i refused with %s while a running read j > i is in flight",
    async (_, ended, terminal) => {
      const w = await world();
      const i = await w.issue();
      const j = await w.issue();
      await w.service.store.run(reconcileTimerCopy, {
        captured: w.service.capture(1),
        order: i,
        drop: () => false,
        scope: { occurrence_id: "day", complete: true, running: [], ended },
        admitted: false,
      });
      const after = await w.authority();
      if (terminal) {
        // Lost through j: the positive the in-flight read may return is not trusted (R27's extension).
        expect(after.endedThrough).toBe(j);
        expect(after.endedLost).toBe(true);
      } else {
        expect(after.endedThrough).toBe(0);
        expect(after.endedLost).toBe(false);
        expect(after.floor).toBe(i);
      }
    },
  );

  test("a record written before revision 6 that lost a session: lost through every order issued, settled ONCE by the next order (which is trusted)", async () => {
    const w = await world();
    await w.issue();
    await w.issue();
    w.seed({
      timer_ended: { lost: true, ids: [[S, 1]] } as never,
      timer_order: 5,
    });
    expect(await w.authority()).toMatchObject({
      ended: [S],
      endedLost: true,
      endedThrough: 5,
    });
    const next = await w.issue();
    expect(next).toBe(6);
    expect(w.sync().timer_ended).toEqual({
      lost: true,
      ids: [[S, 1]],
      through: 5,
    });
    // The bound no longer moves with each order issued.
    await w.issue();
    expect((await w.authority()).endedThrough).toBe(5);
  });

  test("an older record that lost nothing reads as nothing lost; a record that does not read is lost through every order issued, then settled", async () => {
    const w = await world();
    w.seed({ timer_ended: { lost: false, ids: [[S, 1]] } as never });
    expect(await w.authority()).toMatchObject({
      endedLost: false,
      endedThrough: 0,
    });
    w.seed({ timer_ended: "damaged" as never, timer_order: 7 });
    expect(await w.authority()).toMatchObject({
      endedLost: true,
      endedThrough: 7,
    });
    expect(await w.issue()).toBe(8);
    expect(w.sync().timer_ended).toEqual({ lost: true, ids: [], through: 7 });
    w.seed({ timer_ended: { lost: false, ids: [], through: -1 } as never });
    expect((await w.authority()).endedLost).toBe(true);
  });
});

/**
 * Revision 6 (review 6 R28): further exact days by key (a selected day, a day a command asked for) and a longer window of latest rows
 * (the detail's "Show earlier days"), in the same bounded read; `complete` says whether the window holds every row.
 */
describe("W27: further exact days and a longer window (revision 6, review R28)", () => {
  test("exact days are found past the window and absent ones are null; a longer window is one read of the latest rows; bounds hold", async () => {
    const { t, service } = await bound();
    const days = Array.from({ length: 20 }, (_, i) =>
      row({ through_date: `2026-11-${String(1 + i).padStart(2, "0")}` }),
    );
    t.world.idb.seed(DB, "materialise_sequences", days);
    const read = (tasks: TaskSequencesAsk[]) =>
      service.store.run(readTaskSequences, {
        incarnationId: service.incarnationId,
        tasks,
      });
    const found = await read([
      { taskId: TASK, days: ["2026-11-01", "2026-12-25"] },
    ]);
    expect(found[TASK]?.days).toEqual({
      "2026-11-01": days[0],
      "2026-12-25": null,
    });
    expect(found[TASK]?.rows).toEqual(days.slice(-TASK_SEQUENCE_ROWS));
    expect(found[TASK]?.complete).toBe(false);
    const longer = await read([{ taskId: TASK, rows: 16 }]);
    expect(longer[TASK]?.rows).toEqual(days.slice(-16));
    expect(longer[TASK]?.complete).toBe(false);
    expect(longer[TASK]?.days).toBeUndefined();
    const all = await read([{ taskId: TASK, rows: 24 }]);
    expect(all[TASK]?.rows).toEqual(days);
    expect(all[TASK]?.complete).toBe(true);
    await expect(
      read([
        {
          taskId: TASK,
          days: Array.from(
            { length: TASK_SEQUENCE_DAYS + 1 },
            (_, i) => `2026-12-${String(1 + i).padStart(2, "0")}`,
          ),
        },
      ]),
    ).rejects.toThrow();
    await expect(read([{ taskId: TASK, rows: 0 }])).rejects.toThrow();
  });
});

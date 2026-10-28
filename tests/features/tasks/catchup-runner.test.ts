// @vitest-environment node
import { describe, expect, test } from "vitest";
import { commitMaterialiseDiscovery } from "../../../src/data";
import type { AccountService } from "../../../src/data/engine/account-service";
import type {
  MaterialiseDiscovery,
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import { SEQUENCE_ROW_BYTES } from "../../../src/data/plans/materialise";
import type {
  MaterialiseCommand,
  TasksApi,
  TasksResult,
} from "../../../src/features/tasks/api";
import {
  type CatchUpRunner,
  createCatchUpRunner,
  seenDiscovery,
  seenSequence,
} from "../../../src/features/tasks/catchup/runner";
import type { TaskDetail } from "../../../src/features/tasks/model/contract";
import { attemptBody } from "../../../src/features/tasks/model/materialise";
import { addDays, todayIn } from "../../../src/features/tasks/model/time";
import { ACCOUNT, DB, defaultsWorld } from "../../support/data/defaults-world";
import { cacheRow } from "../../support/data/rows";

/**
 * The catch-up runner (plan §4.1; A1–A4, A19) over the PRODUCTION W27 plans and account service on the double of IndexedDB, with a
 * scripted `TasksApi` (the position read and `materialise`) and recorded waits instead of timers: the bound, no progress, the horizon,
 * uncertain answers with the same key, a reload in each phase, two runners and one lock, an identity that ends, and pausing offline.
 * FIXTURE evidence: no backend.
 */
const TASK = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ZONE = "UTC";
const NOW = Date.UTC(2026, 9, 25, 12);
const TODAY = todayIn(ZONE, NOW);

interface Script {
  /** Each position read answers the next, or this when they run out. */
  positions: Array<
    TasksResult<TaskDetail> | (() => Promise<TasksResult<TaskDetail>>)
  >;
  sends: Array<
    | TasksResult<{ revision: number }>
    | (() => Promise<TasksResult<{ revision: number }>>)
  >;
}

const detail = (
  last: string | null,
  pending: boolean,
  materialisation = true,
): TasksResult<TaskDetail> => ({
  ok: true,
  value: {
    task: cacheRow({ id: TASK, kind: "task", label: "Water the plants" }),
    execution: cacheRow({
      id: "aaaaaaaa-0000-4000-8000-0000000000a2",
      kind: "execution",
      parent_id: TASK,
      label: "Task details",
      value: {
        schedule: {
          start_date: "2026-01-01",
          time: null,
          timezone: ZONE,
          repeat: { frequency: "daily", interval: 1 },
        },
        goal: { kind: "checkbox" },
        carry: "close_incomplete",
        participation: "personal",
        open_days_before: 0,
        close_days_after: 1,
        allow_streak_exclusions: false,
      } as never,
    }),
    materialisation: materialisation ? { last_date: last, pending } : null,
  },
});
const OK: TasksResult<{ revision: number }> = {
  ok: true,
  value: { revision: 7 },
};
const UNCERTAIN = { ok: false, kind: "uncertain" } as const;

async function setup(
  options: { script?: Partial<Script>; seed?: MaterialiseSequenceRow[] } = {},
) {
  const t = await defaultsWorld({ online: false, noReader: true });
  await t.settle();
  if (options.seed) t.world.idb.seed(DB, "materialise_sequences", options.seed);
  const script: Script = {
    positions: [...(options.script?.positions ?? [])],
    sends: [...(options.script?.sends ?? [])],
  };
  const sent: Array<{ command: MaterialiseCommand; key: string }> = [];
  let reads = 0;
  const api = {
    readTask: async () => {
      reads += 1;
      const next = script.positions.shift();
      if (next === undefined) return detail(TODAY, false);
      return typeof next === "function" ? next() : next;
    },
    materialise: async (command: MaterialiseCommand, key: string) => {
      sent.push({ command, key });
      const next = script.sends.shift();
      if (next === undefined) return OK;
      return typeof next === "function" ? next() : next;
    },
  } as unknown as TasksApi;
  const waits: number[] = [];
  let online = true;
  let writable = true;
  let ids = 0;
  const make = (
    over: {
      locks?: LockManager | null;
      service?: () => AccountService | null;
      sleep?: () => Promise<void>;
      quota?: () => import("../../../src/data").DataEnv["quota"] | null;
    } = {},
  ) =>
    createCatchUpRunner({
      api,
      identity: `${ACCOUNT}:1`,
      accountId: ACCOUNT,
      epoch: 1,
      service: over.service ?? (() => t.env.service()),
      online: () => online,
      writable: () => writable,
      now: () => NOW,
      newId: () => {
        ids += 1;
        return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
      },
      sleep: async (ms) => {
        waits.push(ms);
        await over.sleep?.();
      },
      locks: over.locks === undefined ? null : over.locks,
      ...(over.quota ? { quota: over.quota } : {}),
    });
  const idle = async (runner: CatchUpRunner) => {
    for (let i = 0; i < 200; i += 1) {
      await t.settle();
      await new Promise((r) => setTimeout(r, 0));
      if (runner.get().active.length === 0 && !runner.get().waiting) {
        await t.settle();
        if (runner.get().active.length === 0) return;
      }
    }
    throw new Error("the runner never went idle");
  };
  const stored = (through = TODAY) =>
    t.world.idb.peek(DB, "materialise_sequences", [TASK, through]) as
      | MaterialiseSequenceRow
      | undefined;
  const discovery = (task = TASK) =>
    (
      t.world.idb.peek(DB, "sync_state", "singleton") as
        | SyncStateRow
        | undefined
    )?.materialise_discovery?.[task] as MaterialiseDiscovery | undefined;
  return {
    t,
    script,
    sent,
    discovery,
    reads: () => reads,
    waits,
    make,
    idle,
    stored,
    setOnline: (value: boolean) => {
      online = value;
    },
    setWritable: (value: boolean) => {
      writable = value;
    },
  };
}

const row = (
  over: Partial<MaterialiseSequenceRow> = {},
): MaterialiseSequenceRow => ({
  task_id: TASK,
  through_date: TODAY,
  sequence_generation: "g-old",
  phase: "ready",
  attempt: null,
  read_seq: 0,
  successful_calls: 0,
  last_known_position: "2026-10-01",
  started_at: 1,
  read_failures: 0,
  stop: null,
  trigger: "daily",
  ...over,
});

describe("A1/A2: a task is brought up to date, 16 slots a call", () => {
  test("pending → materialise → position → materialise → satisfied: the record is gone and each call had its own key", async () => {
    const w = await setup({
      script: {
        positions: [
          detail("2026-09-20", true),
          detail("2026-10-06", true),
          detail(TODAY, false),
        ],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent.map((s) => s.command)).toEqual([
      { kind: "materialise", task_id: TASK, through_date: TODAY, limit: 16 },
      { kind: "materialise", task_id: TASK, through_date: TODAY, limit: 16 },
    ]);
    expect(new Set(w.sent.map((s) => s.key)).size).toBe(2);
    expect(w.reads()).toBe(3);
    expect(w.stored()).toBeUndefined();
    expect(runner.get().finished).toBe(1);
  });

  test("nothing to do writes nothing and sends nothing; asked again for the same day it reads nothing more", async () => {
    const w = await setup({ script: { positions: [detail(TODAY, false)] } });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toEqual([]);
    expect(w.reads()).toBe(1);
    expect(w.stored()).toBeUndefined();
  });

  test("MU-10C-01 (runner): a task needing more than 128 slots stops after exactly eight counted calls; Try again continues from the position with a fresh budget", async () => {
    let last = "2025-01-01";
    const advancing = () => {
      last = addDays(last, 16);
      return Promise.resolve(detail(last, true));
    };
    const w = await setup({
      script: { positions: Array.from({ length: 40 }, () => advancing) },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(8);
    expect(w.stored()).toMatchObject({
      phase: "stopped",
      stop: { reason: "bound" },
      successful_calls: 8,
      last_known_position: last,
    });
    const reached = last;
    runner.tryAgain(TASK, TODAY);
    await w.idle(runner);
    expect(w.sent).toHaveLength(16);
    expect(new Set(w.sent.map((s) => s.key)).size).toBe(16);
    expect((w.stored()?.last_known_position ?? "") > reached).toBe(true);
    expect(w.stored()?.stop).toEqual({ reason: "bound" });
  });

  test("MU-10C-02 (runner): a call that did not move the position stops with no progress, and is not restarted automatically", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()?.stop).toEqual({ reason: "no_progress" });
    // MU-10C-08: another ensure (Today read again) never resumes it.
    const second = w.make();
    second.ensure(TASK, "daily");
    await w.idle(second);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()?.phase).toBe("stopped");
  });
});

describe("A2: the horizon, and A4: a terminal refusal", () => {
  test("a day beyond today + 31 is stopped (horizon) and nothing is sent", async () => {
    const far = addDays(TODAY, 32);
    const w = await setup({
      script: { positions: [detail("2026-10-01", true)] },
    });
    const runner = w.make();
    runner.ensure(TASK, "draft", { throughDate: far });
    await w.idle(runner);
    expect(w.sent).toEqual([]);
    expect(w.stored(far)?.stop).toEqual({ reason: "horizon" });
  });

  test("MU-10C-10 (runner): the archived task's 422 during a held sequence stops it (rejected) with its request id, and nothing more is sent", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true), detail("2026-09-17", true)],
        sends: [OK, { ok: false, kind: "invalid", requestId: "req-422" }],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(2);
    expect(w.stored()).toMatchObject({
      phase: "stopped",
      attempt: null,
      stop: { reason: "rejected", request_id: "req-422" },
    });
  });

  test("503 slice_capacity stops it as capacity", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true)],
        sends: [{ ok: false, kind: "uncertain", code: "slice_capacity" }],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.stored()?.stop?.reason).toBe("capacity");
  });
});

describe("A19: uncertain answers resend the SAME key, paced and bounded", () => {
  test("MU-10C-06 (runner): two uncertain sends are resent with their key after 1 s and 2 s; the third stops (unreachable) keeping it; Try again resends it", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true), detail(TODAY, false)],
        sends: [UNCERTAIN, UNCERTAIN, UNCERTAIN, OK],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(3);
    expect(new Set(w.sent.map((s) => s.key)).size).toBe(1);
    expect(w.waits).toEqual([1_000, 2_000]);
    const held = w.stored();
    expect(held).toMatchObject({
      phase: "stopped",
      stop: { reason: "unreachable" },
    });
    expect(held?.attempt?.key).toBe(w.sent[0]?.key);
    runner.tryAgain(TASK, TODAY);
    await w.idle(runner);
    expect(w.sent).toHaveLength(4);
    expect(w.sent[3]?.key).toBe(w.sent[0]?.key);
    expect(w.stored()).toBeUndefined();
  });

  /**
   * Adaptation (revision 2, review R13/DA-M1): this case expected the stop in page memory only (`unrecorded`). Its intent (a stop shown,
   * no sequence row, nothing sent; Try again reads again) is kept; the stop is now the task's durable discovery entry, shown from there.
   */
  test("a first read that never answers is a stop (its discovery entry; no sequence, nothing sent); Try again reads again", async () => {
    const w = await setup({
      script: { positions: [UNCERTAIN, UNCERTAIN, UNCERTAIN] as never },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    // Revision 3 (R16): the stop also names the admitted read that met it (its attempt); every other field as before.
    expect(w.discovery()).toEqual({
      attempt: expect.any(String),
      retry: 0,
      failures: 3,
      stop: { reason: "unreachable" },
    });
    expect(runner.get().unrecorded.size).toBe(0);
    expect(w.sent).toEqual([]);
    expect(w.stored()).toBeUndefined();
    runner.tryAgain(TASK);
    await w.idle(runner);
    expect(w.discovery()).toBeUndefined();
    expect(w.reads()).toBe(4);
  });
});

describe("A3: a reload, a takeover or a crash in each phase", () => {
  test("held in submitting: the stored attempt is resent with ITS key (no new key)", async () => {
    const w = await setup({
      seed: [
        row({
          phase: "submitting",
          attempt: { key: "kept-key", body: attemptBody(TASK, TODAY) },
        }),
      ],
      script: { positions: [detail("2026-10-01", true), detail(TODAY, false)] },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent.map((s) => s.key)).toEqual(["kept-key"]);
    expect(w.stored()).toBeUndefined();
  });

  test("held in awaiting_position_read: exactly ONE position read and no materialise", async () => {
    const w = await setup({
      seed: [row({ phase: "awaiting_position_read", read_seq: 3 })],
      script: { positions: [detail(TODAY, false)] },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    expect(w.sent).toEqual([]);
    expect(w.stored()).toBeUndefined();
  });

  test("held in ready: it continues (the attempt written before the send)", async () => {
    const w = await setup({
      seed: [row()],
      script: { positions: [detail("2026-10-01", true), detail(TODAY, false)] },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()).toBeUndefined();
  });
});

describe("one runner per account, and its identity", () => {
  test("two runners share ONE lock: the second waits, then finds the work done; one sequence was sent", async () => {
    let holder: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (
        _name: string,
        _options: unknown,
        run: () => Promise<unknown>,
      ) => {
        const mine = holder.then(() => run());
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    const w = await setup({
      script: {
        positions: [
          detail("2026-09-01", true),
          detail(TODAY, false),
          detail(TODAY, false),
        ],
      },
    });
    const a = w.make({ locks });
    const b = w.make({ locks });
    a.ensure(TASK, "daily");
    b.ensure(TASK, "daily");
    await w.idle(a);
    await w.idle(b);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()).toBeUndefined();
  });

  test("an identity that ends while a call is held: its answer is not committed, and nothing more is sent", async () => {
    let release: (value: TasksResult<{ revision: number }>) => void = () =>
      undefined;
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true)],
        sends: [() => new Promise((resolve) => (release = resolve))],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    for (let i = 0; i < 50 && w.sent.length === 0; i += 1) await w.t.settle();
    expect(w.stored()?.phase).toBe("submitting");
    runner.dispose();
    release(OK);
    await w.t.settle();
    await new Promise((r) => setTimeout(r, 0));
    await w.t.settle();
    expect(w.stored()?.phase).toBe("submitting");
    expect(w.sent).toHaveLength(1);
  });

  test("offline: nothing is read or sent; online again (kick) the work proceeds", async () => {
    const w = await setup({
      script: { positions: [detail("2026-09-01", true), detail(TODAY, false)] },
    });
    w.setOnline(false);
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.t.settle();
    expect(w.reads()).toBe(0);
    expect(runner.get().active).toEqual([TASK]);
    w.setOnline(true);
    runner.kick();
    await w.idle(runner);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()).toBeUndefined();
  });
});

/**
 * Revision 1 (review R1): work that stopped PART-WAY (a pause that can clear, not a stop) resumes THE SAME sequence when what paused it
 * clears: `kick` (connectivity, compatibility or the binding moved) or `ensure` of the task (Today's next read). The stored attempt is
 * resent with its own key, an answered call has only its position read (CM-440), and a genuine stop is never restarted.
 */
describe("R1: paused work resumes the same sequence", () => {
  const heldSend = () => {
    let release: (value: TasksResult<{ revision: number }>) => void = () =>
      undefined;
    let asked = false;
    return {
      send: () =>
        new Promise<TasksResult<{ revision: number }>>((resolve) => {
          asked = true;
          release = resolve;
        }),
      asked: () => asked,
      release: (value: TasksResult<{ revision: number }>) => release(value),
    };
  };

  for (const resume of ["kick", "ensure"] as const)
    test(`offline between a successful send and its position read: online again (${resume}) the position alone is read and the sequence completes`, async () => {
      const held = heldSend();
      const w = await setup({
        script: {
          positions: [detail("2026-09-01", true), detail(TODAY, false)],
          sends: [held.send],
        },
      });
      const runner = w.make();
      runner.ensure(TASK, "daily");
      for (let i = 0; i < 100 && !held.asked(); i += 1) await w.t.settle();
      expect(w.sent).toHaveLength(1);
      expect(w.stored()?.phase).toBe("submitting");
      w.setOnline(false);
      held.release(OK);
      await w.idle(runner);
      // The answer was committed; the read it needs waits for the connection.
      expect(w.stored()?.phase).toBe("awaiting_position_read");
      expect(w.reads()).toBe(1);
      w.setOnline(true);
      if (resume === "kick") runner.kick();
      else runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(w.stored(), "the sequence completed").toBeUndefined();
      expect(w.reads(), "exactly one more read: the position").toBe(2);
      expect(w.sent, "no new materialise").toHaveLength(1);
      expect(runner.get().finished).toBe(1);
    });

  test("the session held the send (not_sent): kicked, the stored attempt is resent with ITS key", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true), detail(TODAY, false)],
        sends: [{ ok: false, kind: "not_sent" } as never, OK],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.stored()?.phase).toBe("submitting");
    expect(w.sent).toHaveLength(1);
    runner.kick();
    await w.idle(runner);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]?.key, "the same key, never a fresh one").toBe(
      w.sent[0]?.key,
    );
    expect(w.stored()).toBeUndefined();
  });

  test("compatibility lost after the first read: nothing is written past ready or sent; compatible again (kick) one attempt is written, sent once and the sequence completes", async () => {
    const w = await setup({
      script: {
        positions: [
          async () => {
            // The read is answered; compatibility is lost before the attempt is sent.
            w.setWritable(false);
            return detail("2026-09-01", true);
          },
          detail(TODAY, false),
        ],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(0);
    // The sequence was begun and left as it stood: ready, no attempt (it is written only when it is about to be sent).
    expect(w.stored()?.phase).toBe("ready");
    expect(w.stored()?.attempt).toBeNull();
    w.setWritable(true);
    runner.kick();
    await w.idle(runner);
    expect(w.sent).toHaveLength(1);
    expect(w.stored()).toBeUndefined();
  });

  test("a read that throws part-way is a pause, not an end: kicked, only the position is read and the sequence completes", async () => {
    const w = await setup({
      script: {
        positions: [
          detail("2026-09-01", true),
          async () => {
            throw new Error("a thrown read");
          },
          detail(TODAY, false),
        ],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.stored()?.phase).toBe("awaiting_position_read");
    expect(w.sent).toHaveLength(1);
    runner.kick();
    await w.idle(runner);
    expect(w.stored()).toBeUndefined();
    expect(w.sent).toHaveLength(1);
  });

  test("control: a genuine stop is not parked: kick and ensure restart nothing; the healthy two-call completion is unchanged", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-09-01", true), detail("2026-09-01", true)],
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.stored()?.phase).toBe("stopped");
    expect(w.stored()?.stop?.reason).toBe("no_progress");
    const sent = w.sent.length;
    const reads = w.reads();
    runner.kick();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.sent).toHaveLength(sent);
    expect(w.reads()).toBe(reads);
    expect(w.stored()?.phase).toBe("stopped");
  });
});

/**
 * Revision 2 (review R13, design assessment DA-M1): the DISCOVERY (the first read of a task, before its day is known) owns a durable budget
 * and stop in W27's discovery entry. A stop admits no automatic read or send again, whichever trigger asks, across a reload or another
 * runner; a pause keeps the count reached; only "Try again" admits a fresh budget, once, however often or wherever it is pressed.
 */
describe("R13: a stopped discovery stays stopped until Try again", () => {
  test("REVIEW2 M1 (ported): three uncertain first reads stop it; Today, the streak, a command's retry and a kick read and send nothing more", async () => {
    const w = await setup({
      script: {
        positions: [
          UNCERTAIN,
          UNCERTAIN,
          UNCERTAIN,
          detail("2026-09-01", true),
          detail(TODAY, false),
        ] as never,
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.reads()).toBe(3);
    expect(w.waits).toEqual([1_000, 2_000]);
    expect(w.discovery()?.stop).toEqual({ reason: "unreachable" });
    runner.ensure(TASK, "daily");
    runner.ensure(TASK, "streak");
    runner.ensure(TASK, "draft");
    runner.kick();
    await w.idle(runner);
    expect(w.reads()).toBe(3);
    expect(w.sent).toHaveLength(0);
    expect(w.discovery()?.stop).toEqual({ reason: "unreachable" });
  });

  test("control: Try again owns a fresh budget, catches up and leaves no stop (nor a stale one in memory)", async () => {
    const w = await setup({
      script: {
        positions: [
          UNCERTAIN,
          UNCERTAIN,
          UNCERTAIN,
          detail("2026-09-01", true),
          detail(TODAY, false),
        ] as never,
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    runner.tryAgain(TASK);
    await w.idle(runner);
    expect(w.sent).toHaveLength(1);
    expect(w.reads()).toBe(5);
    expect(w.discovery()).toBeUndefined();
    expect(runner.get().unrecorded.size).toBe(0);
    expect(w.stored()).toBeUndefined();
  });

  test("a definite refusal of the first read is a stop (with its request id); automatic triggers do nothing; control: healthy catches up", async () => {
    const w = await setup({
      script: {
        positions: [
          { ok: false, kind: "forbidden", requestId: "req-1" },
        ] as never,
      },
    });
    const runner = w.make();
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.discovery()?.stop).toEqual({
      reason: "rejected",
      request_id: "req-1",
    });
    runner.ensure(TASK, "streak");
    runner.kick();
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    expect(w.sent).toHaveLength(0);
    const healthy = await setup({
      script: { positions: [detail("2026-09-01", true), detail(TODAY, false)] },
    });
    const control = healthy.make();
    control.ensure(TASK, "daily");
    await healthy.idle(control);
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.discovery()).toBeUndefined();
  });

  test("a pause between uncertain reads keeps the count: online again only the REMAINING budget is read", async () => {
    const w = await setup({
      script: {
        positions: [UNCERTAIN, UNCERTAIN, UNCERTAIN, UNCERTAIN] as never,
      },
    });
    let paused = false;
    const runner = createCatchUpRunnerWithSleep(w, async () => {
      if (!paused) {
        paused = true;
        w.setOnline(false);
      }
    });
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    expect(w.discovery()?.failures).toBe(1);
    w.setOnline(true);
    runner.kick();
    await w.idle(runner);
    expect(w.reads()).toBe(3);
    expect(w.discovery()?.stop).toEqual({ reason: "unreachable" });
  });

  test("a reload (another runner on the same database) adopts the count and the stop before any extra read", async () => {
    let hold: (value: unknown) => void = () => undefined;
    const w = await setup({
      script: {
        positions: [
          UNCERTAIN,
          UNCERTAIN,
          () => new Promise((resolve) => (hold = resolve)),
          UNCERTAIN,
          UNCERTAIN,
        ] as never,
      },
    });
    const first = w.make();
    first.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.reads() < 3; i += 1) await w.t.settle();
    expect(w.discovery()?.failures).toBe(2);
    first.dispose();
    hold(UNCERTAIN);
    await w.t.settle();
    const second = w.make();
    second.ensure(TASK, "daily");
    await w.idle(second);
    // One more read reached the bound (2 + 1); the held answer of the ended page wrote nothing.
    expect(w.reads()).toBe(4);
    // Revision 3 (R16): the stop also names the admitted read that met it (its attempt); every other field as before.
    expect(w.discovery()).toEqual({
      attempt: expect.any(String),
      retry: 0,
      failures: 3,
      stop: { reason: "unreachable" },
    });
    const third = w.make();
    third.ensure(TASK, "daily");
    await w.idle(third);
    expect(w.reads()).toBe(4);
    // Another task's success does not lift it.
    expect(w.discovery()?.stop).not.toBeNull();
  });

  test("two Try again presses on one stop (two pages sharing the lock) admit ONE fresh budget", async () => {
    let holder: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (
        _name: string,
        _options: unknown,
        run: () => Promise<unknown>,
      ) => {
        const mine = holder.then(() => run());
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    const w = await setup({
      script: {
        positions: Array.from({ length: 9 }, () => UNCERTAIN) as never,
      },
    });
    const a = w.make({ locks });
    const b = w.make({ locks });
    a.ensure(TASK, "daily");
    await w.idle(a);
    expect(w.reads()).toBe(3);
    a.tryAgain(TASK);
    b.tryAgain(TASK);
    await w.idle(a);
    await w.idle(b);
    // One budget (three more reads), not two; the stop stands again under the ONE new retry.
    expect(w.reads()).toBe(6);
    // Revision 3 (R16): the stop also names the admitted read that met it (its attempt); every other field as before.
    expect(w.discovery()).toEqual({
      attempt: expect.any(String),
      retry: 1,
      failures: 3,
      stop: { reason: "unreachable" },
    });
  });

  test("a stop whose record cannot be written is kept in this page's memory and refuses automatic work alike; Try again reads again", async () => {
    const w = await setup({
      script: {
        positions: [
          UNCERTAIN,
          detail("2026-09-01", true),
          detail(TODAY, false),
        ] as never,
      },
    });
    let failing = true;
    // Adaptations (revision 3): ONE double per binding (design assessment DA-H2: a new handle on every lookup is another binding to the
    // runner now, R17), and only an ANSWER's record fails (a count, a stop or a success's removal): a read's admission (the same count, a
    // new attempt; R16) is written, so automatic work refused here is refused by the memory stop, not by a failing store.
    const real = w.t.env.service() as AccountService;
    type Write = {
      expected?: { failures: number } | null;
      next?: { failures: number; stop: unknown } | null;
    };
    const admission = (input: Write) =>
      input.next != null &&
      input.next.stop === null &&
      input.next.failures === (input.expected?.failures ?? 0);
    const failingService = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "commit") return Reflect.get(target, key, receiver);
        return (plan: { name: string }, input: Write) =>
          failing &&
          plan.name === "data.writeMaterialiseDiscovery" &&
          !admission(input)
            ? Promise.resolve({ kind: "failed" })
            : target.commit(plan as never, input as never);
      },
    }) as AccountService;
    const runner = w.make({ service: () => failingService });
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    // Revision 5 (R26): every memory stop carries its own identity.
    expect(runner.get().unrecorded.get(TASK)).toEqual({
      reason: "unreachable",
      id: expect.any(String),
    });
    // The admitted read's entry, its answer unrecorded: no stop, no count.
    expect(w.discovery()).toMatchObject({ failures: 0, stop: null });
    runner.ensure(TASK, "daily");
    runner.kick();
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    failing = false;
    runner.tryAgain(TASK);
    await w.idle(runner);
    expect(runner.get().unrecorded.size).toBe(0);
    expect(w.sent).toHaveLength(1);
  });
});

/** A runner of the world `w` whose waits run `onSleep` (the pause test sets the connection from inside a wait). */
function createCatchUpRunnerWithSleep(
  w: Awaited<ReturnType<typeof setup>>,
  onSleep: () => Promise<void>,
) {
  return w.make({ sleep: onSleep });
}

const discoveries = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
      { retry: 0, failures: 3, stop: { reason: "unreachable" } },
    ]),
  );

/**
 * Revision 3 (review R16, family `materialise-discovery-retry-durability`): REVIEW3 M2, ported. However many other tasks' discovery stops
 * the database already holds (99, 100 or 101), a definite refusal of this task's first read is a DURABLE stop: a new runner on the same
 * database (a reload) reads nothing more automatically, and nothing is sent. The others' stops are kept as they were.
 */
describe("R16: a discovery stop survives a reload at any number of other stops", () => {
  test.each([99, 100, 101])(
    "REVIEW3 M2 (ported): %s other stops; a refusal, then a reload: one read in all",
    async (count) => {
      const w = await setup({
        script: {
          positions: [
            { ok: false, kind: "forbidden", requestId: "refused-101" },
            { ok: false, kind: "forbidden", requestId: "refused-101" },
          ] as never,
        },
      });
      const sync = w.t.world.idb.peek(
        DB,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      const others = discoveries(count);
      w.t.world.idb.seed(DB, "sync_state", [
        { ...sync, materialise_discovery: others } as never,
      ]);
      const first = w.make();
      first.ensure(TASK, "daily");
      await w.idle(first);
      expect(w.reads()).toBe(1);
      expect(w.sent).toHaveLength(0);
      expect(
        w.discovery()?.stop ?? first.get().unrecorded.get(TASK),
      ).toBeDefined();
      first.dispose();
      const second = w.make();
      second.ensure(TASK, "streak");
      await w.idle(second);
      expect(w.reads()).toBe(1);
      expect(w.sent).toHaveLength(0);
      expect(w.discovery()?.stop).toMatchObject({
        reason: "rejected",
        request_id: "refused-101",
      });
      const kept = (
        w.t.world.idb.peek(DB, "sync_state", "singleton") as SyncStateRow
      ).materialise_discovery;
      for (const [task, entry] of Object.entries(others))
        expect(kept?.[task]).toMatchObject(entry);
      second.dispose();
    },
  );
});

/**
 * Revision 3 (review R17, family `materialise-discovery-binding-ownership`): REVIEW3 M3, ported. The first read is answered after the
 * service it was asked under has closed and a fresh service (another database of the same account) has replaced it: the answer belongs
 * to the ended binding and writes nothing into the replacement. The control keeps one service: its refusal is recorded as usual.
 */
describe("R17: a discovery answer belongs to the service that asked it", () => {
  test.each([false, true])(
    "REVIEW3 M3 (ported): the service is replaced before the refusal arrives = %s",
    async (replace) => {
      let release: (r: TasksResult<TaskDetail>) => void = () => undefined;
      const w = await setup({
        script: {
          positions: [
            () =>
              new Promise<TasksResult<TaskDetail>>((r) => {
                release = r;
              }),
          ],
        },
      });
      const fresh = await defaultsWorld({ online: false, noReader: true });
      await fresh.settle();
      const old = w.t.env.service() as AccountService;
      let service = old;
      const runner = w.make({ service: () => service });
      runner.ensure(TASK, "daily");
      for (let i = 0; i < 100 && w.reads() === 0; i += 1) await w.t.settle();
      expect(w.reads()).toBe(1);
      if (replace) {
        old.dispose("closed");
        service = fresh.env.service() as AccountService;
      }
      release({
        ok: false,
        kind: "forbidden",
        requestId: "old-binding",
      } as never);
      await w.idle(runner);
      await fresh.settle();
      const replacement = fresh.world.idb.peek(
        DB,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      if (replace)
        expect(replacement.materialise_discovery?.[TASK]).toBeUndefined();
      else expect(w.discovery()?.stop?.reason).toBe("rejected");
      runner.dispose();
    },
  );
});

const refusing = {
  reserve: async () =>
    ({
      verdict: "refuse",
      live: () => false,
      settle: () => undefined,
    }) as never,
} as never;
const admitting = {
  reserve: async () =>
    ({
      verdict: "ok",
      live: () => true,
      settle: () => undefined,
    }) as never,
} as never;

describe("R16: a first read is admitted before it is sent", () => {
  test("the quota ledger refuses the task's record: nothing is read, a storage stop is shown; a reload reads nothing until it is admitted", async () => {
    const w = await setup();
    const first = w.make({ quota: () => refusing });
    first.ensure(TASK, "daily");
    await w.idle(first);
    expect(w.reads()).toBe(0);
    expect(first.get().unrecorded.get(TASK)).toEqual({
      reason: "storage",
      id: expect.any(String),
    });
    first.ensure(TASK, "streak");
    first.kick();
    await w.idle(first);
    expect(w.reads()).toBe(0);
    first.dispose();
    const second = w.make({ quota: () => refusing });
    second.ensure(TASK, "daily");
    await w.idle(second);
    expect(w.reads()).toBe(0);
    expect(w.discovery()).toBeUndefined();
    second.dispose();
    // Control: admitted, the read is made and recorded as usual (here: found, caught up, the record gone).
    const third = w.make({ quota: () => admitting });
    third.ensure(TASK, "daily");
    await w.idle(third);
    expect(w.reads()).toBeGreaterThan(0);
    expect(w.discovery()).toBeUndefined();
  });

  test("two pages without Web Locks: the later claim wins; the earlier read's refusal, released afterwards, records nothing and spends no budget", async () => {
    let release: (r: TasksResult<TaskDetail>) => void = () => undefined;
    const w = await setup({
      script: {
        positions: [
          () =>
            new Promise<TasksResult<TaskDetail>>((r) => {
              release = r;
            }),
          UNCERTAIN,
        ],
      },
    });
    const a = w.make();
    a.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.reads() === 0; i += 1) await w.t.settle();
    const claimed = w.discovery()?.attempt;
    expect(claimed).toEqual(expect.any(String));
    const b = w.make({ sleep: () => new Promise(() => undefined) });
    b.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.reads() < 2; i += 1) await w.t.settle();
    expect(w.reads()).toBe(2);
    await w.t.settle();
    // b's uncertain answer is recorded over b's claim.
    expect(w.discovery()).toMatchObject({ failures: 1, stop: null });
    release({ ok: false, kind: "forbidden", requestId: "late-a" } as never);
    await w.idle(a);
    expect(w.discovery()).toMatchObject({ failures: 1, stop: null });
    expect(w.discovery()?.attempt).not.toBe(claimed);
    expect(a.get().unrecorded.size).toBe(0);
    a.dispose();
    b.dispose();
  });
});

describe("R17: work belongs to the binding it began with", () => {
  async function replaced(answer: TasksResult<TaskDetail>, gap: boolean) {
    let release: (r: TasksResult<TaskDetail>) => void = () => undefined;
    const w = await setup({
      script: {
        positions: [
          () =>
            new Promise<TasksResult<TaskDetail>>((r) => {
              release = r;
            }),
        ],
      },
    });
    const fresh = await defaultsWorld({ online: false, noReader: true });
    await fresh.settle();
    const old = w.t.env.service() as AccountService;
    let service: AccountService | null = old;
    const runner = w.make({ service: () => service });
    runner.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.reads() === 0; i += 1) await w.t.settle();
    old.dispose("closed");
    if (gap) {
      // An unbound moment (no service displayed) before the replacement binds.
      service = null;
      release(answer);
      await w.idle(runner);
      service = fresh.env.service() as AccountService;
      runner.kick();
    } else {
      service = fresh.env.service() as AccountService;
      release(answer);
    }
    await w.idle(runner);
    await fresh.settle();
    return { w, fresh, runner };
  }

  test.each([
    [false, "a success"],
    [true, "a success"],
    [false, "an uncertain answer"],
    [true, "an uncertain answer"],
  ] as const)(
    "unbound moment first = %s; %s of the ended binding writes nothing in the replacement: its own read decides there",
    async (gap, which) => {
      const { w, fresh, runner } = await replaced(
        which === "a success" ? detail("2026-09-01", true) : UNCERTAIN,
        gap,
      );
      // Asked again under the replacement: its own read (the script's default: up to date) decides; nothing of the old answer remains.
      expect(w.reads()).toBe(2);
      expect(w.sent).toEqual([]);
      const sync = fresh.world.idb.peek(
        DB,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      expect(sync.materialise_discovery?.[TASK]).toBeUndefined();
      expect(
        fresh.world.idb.peek(DB, "materialise_sequences", [TASK, TODAY]),
      ).toBeUndefined();
      runner.dispose();
    },
  );

  test("a Try again pressed under the ended binding lifts nothing in the replacement: its stop stands until pressed there", async () => {
    const w = await setup();
    const fresh = await defaultsWorld({ online: false, noReader: true });
    await fresh.settle();
    const stopped = { retry: 0, failures: 3, stop: { reason: "unreachable" } };
    for (const world of [w.t, fresh]) {
      const sync = world.world.idb.peek(
        DB,
        "sync_state",
        "singleton",
      ) as SyncStateRow;
      world.world.idb.seed(DB, "sync_state", [
        { ...sync, materialise_discovery: { [TASK]: stopped } } as never,
      ]);
    }
    const old = w.t.env.service() as AccountService;
    let service: AccountService = old;
    const held: Array<() => void> = [];
    const runner = w.make({
      service: () => service,
      locks: {
        request: (_name: string, _o: unknown, fn: () => Promise<void>) =>
          new Promise<void>((resolve, reject) => {
            held.push(() => {
              fn().then(resolve, reject);
            });
          }),
      } as unknown as LockManager,
    });
    runner.tryAgain(TASK);
    for (let i = 0; i < 100 && held.length === 0; i += 1) await w.t.settle();
    expect(held).toHaveLength(1);
    old.dispose("closed");
    service = fresh.env.service() as AccountService;
    for (const go of held.splice(0)) go();
    await w.idle(runner);
    await fresh.settle();
    expect(w.reads()).toBe(0);
    const sync = fresh.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    expect(sync.materialise_discovery?.[TASK]).toMatchObject(stopped);
    runner.dispose();
  });
});

/**
 * Revision 4 (review R20, family `materialise-sequence-retry-generation`): a "Try again" names the very stop it was pressed on. Every W27
 * write moves the row's revision, so a stop that came back the same way (same generation, phase, read and attempt key) after another
 * press's budget is not the stop a queued press saw. REVIEW4 M4 is ported verbatim: the lock double holds every callback until the
 * previous one settles and holds the first grant until both presses have queued (no send before it).
 */
describe("R20: one stop, one fresh budget", () => {
  const KEY = "eeeeeeee-0000-4000-8000-000000000001";
  const heldLocks = () => {
    let unlock!: () => void;
    let holder: Promise<unknown> = new Promise<void>((r) => {
      unlock = r;
    });
    let queued = 0;
    const locks = {
      request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
        queued += 1;
        const mine = holder.then(run);
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    return { locks, unlock: () => unlock(), queued: () => queued };
  };

  test.each([1, 2])(
    "REVIEW4 M4 (ported): %s pages press the same stop: one new budget",
    async (pages) => {
      let unlock!: () => void;
      let holder: Promise<unknown> = new Promise<void>((r) => {
        unlock = r;
      });
      let queued = 0;
      const locks = {
        request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
          queued += 1;
          const mine = holder.then(run);
          holder = mine.catch(() => undefined);
          return mine;
        },
      } as unknown as LockManager;
      const attempt = { key: KEY, body: attemptBody(TASK, TODAY) };
      const initial = row({
        phase: "stopped",
        attempt,
        read_failures: 3,
        stop: { reason: "unreachable" },
      });
      const w = await setup({
        seed: [initial],
        script: {
          positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
          sends: Array.from({ length: 6 }, () => UNCERTAIN),
        },
      });
      const a = w.make({ locks });
      const b = w.make({ locks });
      try {
        a.tryAgain(TASK, TODAY);
        if (pages === 2) b.tryAgain(TASK, TODAY);
        for (let i = 0; i < 100 && queued < pages; i++) {
          await w.t.settle();
          await new Promise((r) => setTimeout(r, 0));
        }
        expect(queued).toBe(pages);
        expect(w.sent).toHaveLength(0);
        unlock();
        await w.idle(a);
        await w.idle(b);
        expect(w.sent.map((s) => s.key)).toEqual(Array(3).fill(KEY));
        expect(w.stored()?.phase).toBe("stopped");
      } finally {
        unlock();
        a.dispose();
        b.dispose();
      }
    },
  );

  test("a genuinely later press, on the stop shown after the first budget, grants exactly one more; the first stop's press then adds nothing", async () => {
    const attempt = { key: KEY, body: attemptBody(TASK, TODAY) };
    const w = await setup({
      seed: [
        row({
          phase: "stopped",
          attempt,
          read_failures: 3,
          stop: { reason: "unreachable" },
        }),
      ],
      script: {
        positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
        sends: Array.from({ length: 9 }, () => UNCERTAIN),
      },
    });
    const a = w.make();
    try {
      const first = w.stored() as MaterialiseSequenceRow;
      const seenFirst = {
        kind: "sequence" as const,
        generation: first.sequence_generation,
        revision: first.revision ?? 0,
        discovery: null,
      };
      a.tryAgain(TASK, TODAY, seenFirst);
      await w.idle(a);
      expect(w.sent).toHaveLength(3);
      const second = w.stored() as MaterialiseSequenceRow;
      expect(second.phase).toBe("stopped");
      // The same generation, phase, read and attempt as the first stop: only its revision tells them apart.
      expect([
        second.sequence_generation,
        second.read_seq,
        second.attempt?.key,
      ]).toEqual([first.sequence_generation, first.read_seq, KEY]);
      expect(second.revision).toBeGreaterThan(first.revision ?? 0);
      // A press still naming the first stop (a screen not yet refreshed, another tab): nothing is lifted, nothing sent.
      a.tryAgain(TASK, TODAY, seenFirst);
      await w.idle(a);
      expect(w.sent).toHaveLength(3);
      expect(w.stored()).toEqual(second);
      // A press on the stop shown now: one more budget, the same key and body.
      a.tryAgain(TASK, TODAY, {
        kind: "sequence",
        generation: second.sequence_generation,
        revision: second.revision ?? 0,
        discovery: null,
      });
      await w.idle(a);
      expect(w.sent.map((x) => x.key)).toEqual(Array(6).fill(KEY));
      expect(new Set(w.sent.map((x) => JSON.stringify(x.command))).size).toBe(
        1,
      );
      expect(w.stored()?.phase).toBe("stopped");
    } finally {
      a.dispose();
    }
  });

  test.each([
    ["two pages hold the same displayed stop", 2, 3],
    ["one page (control)", 1, 3],
  ])(
    "presses carrying the stop shown: %s -> %s sends",
    async (_, pages, sends) => {
      const attempt = { key: KEY, body: attemptBody(TASK, TODAY) };
      const w = await setup({
        seed: [
          row({
            phase: "stopped",
            attempt,
            read_failures: 3,
            stop: { reason: "unreachable" },
            revision: 5,
          }),
        ],
        script: {
          positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
          sends: Array.from({ length: 6 }, () => UNCERTAIN),
        },
      });
      const held = heldLocks();
      const a = w.make({ locks: held.locks });
      const b = w.make({ locks: held.locks });
      const seen = {
        kind: "sequence" as const,
        generation: "g-old",
        revision: 5,
        discovery: null,
      };
      try {
        a.tryAgain(TASK, TODAY, seen);
        if (pages === 2) b.tryAgain(TASK, TODAY, seen);
        for (let i = 0; i < 100 && held.queued() < pages; i++) {
          await w.t.settle();
          await new Promise((r) => setTimeout(r, 0));
        }
        expect(held.queued()).toBe(pages);
        expect(w.sent).toHaveLength(0);
        held.unlock();
        await w.idle(a);
        await w.idle(b);
        expect(w.sent).toHaveLength(sends);
      } finally {
        held.unlock();
        a.dispose();
        b.dispose();
      }
    },
  );
});

/**
 * Revision 5 (review 5 R24–R26, design assessment of 28 October 2026). R25: a stop is never deleted because a later day begins; rows go
 * only when a position read covers their own day, each compared as read; a new row is admitted first. R24: another day of a task is its
 * own work. R26: a "Try again" names the stop shown by identities that never recur. REVIEW5 M7 is ported verbatim; M8 with its displayed
 * token built as the screens now build it (the verbatim literal names no claim; see the execution report).
 */
describe("R25: an unsatisfied stop is kept whatever later day begins", () => {
  test.each([false, true])(
    "REVIEW5 M7 (ported): new later horizon sequence=%s must preserve unsatisfied old stop",
    async (later) => {
      const attempt = {
        key: "eeeeeeee-0000-4000-8000-000000000001",
        body: attemptBody(TASK, TODAY),
      };
      const initial = row({
        phase: "stopped",
        attempt,
        read_failures: 3,
        stop: { reason: "unreachable" },
      });
      const w = await setup({
        seed: [initial],
        script: { positions: [detail("2026-10-01", true)] },
      });
      const runner = w.make();
      try {
        runner.ensure(TASK, "draft", {
          throughDate: later ? addDays(TODAY, 32) : TODAY,
        });
        await w.idle(runner);
        expect(w.reads()).toBe(1);
        expect(w.sent).toHaveLength(0);
        if (later)
          expect(w.stored(addDays(TODAY, 32))?.stop?.reason).toBe("horizon");
        expect(w.stored()).toEqual(initial);
      } finally {
        runner.dispose();
      }
    },
  );

  test("a later day's success removes the days its position covers; a later day it does not cover stays", async () => {
    const before = addDays(TODAY, -2);
    const yesterday = addDays(TODAY, -1);
    const ahead = addDays(TODAY, 5);
    const w = await setup({
      seed: [
        row({
          through_date: before,
          phase: "stopped",
          stop: { reason: "bound" },
        }),
        row({
          through_date: yesterday,
          phase: "stopped",
          stop: { reason: "no_progress" },
        }),
        row({
          through_date: ahead,
          phase: "stopped",
          stop: { reason: "bound" },
        }),
      ],
      script: {
        positions: [detail("2026-10-01", true), detail(TODAY, false)],
      },
    });
    const runner = w.make();
    try {
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(w.sent).toHaveLength(1);
      expect(w.stored()).toBeUndefined();
      expect(w.stored(before)).toBeUndefined();
      expect(w.stored(yesterday)).toBeUndefined();
      // Its day is beyond the position reached: still its own need, kept.
      expect(w.stored(ahead)?.stop?.reason).toBe("bound");
    } finally {
      runner.dispose();
    }
  });

  test.each([
    ["refused", true],
    ["admitted (control)", false],
  ])("a new day's row the quota ledger %s", async (_, refuse) => {
    const w = await setup({
      script: {
        positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      },
    });
    const sizes: number[] = [];
    const quota = {
      reserve: async (_c: string, bytes: number) => {
        sizes.push(bytes);
        const no = refuse && bytes === SEQUENCE_ROW_BYTES;
        return {
          verdict: no ? "refuse" : "ok",
          live: () => !no,
          settle: () => undefined,
        };
      },
    } as never;
    const runner = w.make({ quota: () => quota });
    try {
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      // The first read; admitted, the position read after its one call too.
      expect(w.reads()).toBe(refuse ? 1 : 2);
      expect(sizes).toContain(SEQUENCE_ROW_BYTES);
      if (refuse) {
        expect(w.stored()).toBeUndefined();
        expect(w.sent).toHaveLength(0);
        expect(runner.get().unrecorded.get(TASK)?.reason).toBe("storage");
      } else {
        expect(w.sent).toHaveLength(1);
        expect(w.stored()?.stop?.reason).toBe("no_progress");
      }
    } finally {
      runner.dispose();
    }
  });
});

describe("R24: another day of a task is its own work", () => {
  test.each([
    ["two days asked together: both are caught up", 2],
    ["the same day asked twice (control): one sequence", 1],
  ])("%s", async (_, days) => {
    const first = addDays(TODAY, 1);
    const second = days === 2 ? addDays(TODAY, 2) : first;
    const w = await setup({
      script: {
        positions: Array.from({ length: 4 }, () => detail("2026-10-01", true)),
      },
    });
    const runner = w.make();
    try {
      runner.ensure(TASK, "draft", { throughDate: first });
      runner.ensure(TASK, "draft", { throughDate: second });
      await w.idle(runner);
      expect(w.sent.map((s) => s.command.through_date)).toEqual(
        days === 2 ? [first, second] : [first],
      );
      expect(w.stored(first)?.stop?.reason).toBe("no_progress");
      expect(w.stored(second)?.stop?.reason).toBe("no_progress");
    } finally {
      runner.dispose();
    }
  });
});

describe("R26: a press names the stop shown by identities that never recur", () => {
  const queuedLocks = () => {
    let unlock!: () => void;
    let holder: Promise<unknown> = new Promise<void>((r) => {
      unlock = r;
    });
    let queued = 0;
    const locks = {
      request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
        queued += 1;
        const mine = holder.then(run);
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    return { locks, unlock: () => unlock(), queued: () => queued };
  };
  const stopEntry = (attempt: string | null) =>
    ({
      retry: 0,
      failures: 3,
      stop: { reason: "unreachable" as const },
      ...(attempt === null ? {} : { attempt }),
    }) as MaterialiseDiscovery;
  const seedDiscovery = async (
    w: Awaited<ReturnType<typeof setup>>,
    entry: MaterialiseDiscovery,
    expected: MaterialiseDiscovery | null = null,
  ) => {
    const service = w.t.env.service() as AccountService;
    const out = await commitMaterialiseDiscovery(service, service.capture(1), {
      task_id: TASK,
      expected,
      next: entry,
    });
    expect(out).toMatchObject({ kind: "applied", value: { kind: "written" } });
  };

  test.each([false, true])(
    "REVIEW5 M8 (ported; the displayed token as the screens build it): a displayed discovery stop since replaced=%s",
    async (replaced) => {
      const w = await setup();
      const first = stopEntry("eeeeeeee-0000-4000-8000-000000000001");
      await seedDiscovery(w, first);
      // Adaptation: the reviewer's literal `{ kind: "discovery", retry: 0 }` names no claim; the screens now name the one shown.
      const seen = seenDiscovery(w.discovery() as MaterialiseDiscovery);
      const other = w.make();
      const fresh = w.make();
      const stale = w.make();
      try {
        if (replaced) {
          other.tryAgain(TASK, undefined, seen);
          await w.idle(other);
          expect(w.reads()).toBe(1);
          expect(w.discovery()).toBeUndefined();
          w.script.positions.push(UNCERTAIN, UNCERTAIN, UNCERTAIN);
          fresh.ensure(TASK, "daily");
          await w.idle(fresh);
          expect(w.discovery()?.stop?.reason).toBe("unreachable");
          expect(w.discovery()?.retry).toBe(0);
          expect(w.discovery()?.attempt).not.toBe(first.attempt);
        }
        const before = w.reads();
        w.script.positions.push(UNCERTAIN, UNCERTAIN, UNCERTAIN);
        stale.tryAgain(TASK, undefined, seen);
        await w.idle(stale);
        expect(w.reads() - before).toBe(replaced ? 0 : 3);
      } finally {
        other.dispose();
        fresh.dispose();
        stale.dispose();
      }
    },
  );

  test.each([
    ["two pages hold the same displayed discovery stop", 2],
    ["one page (control)", 1],
  ])(
    "presses on one discovery stop queued under the held lock: %s -> one budget",
    async (_, pages) => {
      const w = await setup({
        script: {
          positions: [
            UNCERTAIN,
            UNCERTAIN,
            UNCERTAIN,
            UNCERTAIN,
            UNCERTAIN,
            UNCERTAIN,
          ] as never,
        },
      });
      await seedDiscovery(w, stopEntry("eeeeeeee-0000-4000-8000-000000000002"));
      const seen = seenDiscovery(w.discovery() as MaterialiseDiscovery);
      const held = queuedLocks();
      const a = w.make({ locks: held.locks });
      const b = w.make({ locks: held.locks });
      try {
        a.tryAgain(TASK, undefined, seen);
        if (pages === 2) b.tryAgain(TASK, undefined, seen);
        for (let i = 0; i < 100 && held.queued() < pages; i++) {
          await w.t.settle();
          await new Promise((r) => setTimeout(r, 0));
        }
        expect(held.queued()).toBe(pages);
        expect(w.reads()).toBe(0);
        held.unlock();
        await w.idle(a);
        await w.idle(b);
        expect(w.reads()).toBe(3);
        expect(w.discovery()?.stop?.reason).toBe("unreachable");
      } finally {
        held.unlock();
        a.dispose();
        b.dispose();
      }
    },
  );

  test.each([
    ["shown without one: a discovery stop recorded since is not lifted", false],
    ["shown with it (control): both are lifted", true],
  ])("a day's stop %s", async (_, shownWith) => {
    const attempt = {
      key: "eeeeeeee-0000-4000-8000-000000000003",
      body: attemptBody(TASK, TODAY),
    };
    const w = await setup({
      seed: [
        row({
          phase: "stopped",
          attempt,
          read_failures: 3,
          stop: { reason: "unreachable" },
          revision: 2,
        }),
      ],
      script: { positions: [detail("2026-10-01", true)] },
    });
    const stopped = w.stored() as MaterialiseSequenceRow;
    if (!shownWith) {
      const seen = seenSequence(stopped, null);
      await seedDiscovery(w, stopEntry("eeeeeeee-0000-4000-8000-000000000004"));
      const runner = w.make();
      try {
        runner.tryAgain(TASK, TODAY, seen);
        await w.idle(runner);
        expect(w.reads()).toBe(0);
        expect(w.sent).toHaveLength(0);
        expect(w.stored()).toEqual(stopped);
        expect(w.discovery()?.stop?.reason).toBe("unreachable");
      } finally {
        runner.dispose();
      }
      return;
    }
    await seedDiscovery(w, stopEntry("eeeeeeee-0000-4000-8000-000000000004"));
    const seen = seenSequence(stopped, w.discovery());
    const runner = w.make();
    try {
      runner.tryAgain(TASK, TODAY, seen);
      await w.idle(runner);
      expect(w.reads()).toBeGreaterThan(0);
      expect(w.sent.map((s) => s.key)).toContain(attempt.key);
      expect(w.discovery()?.stop ?? null).toBeNull();
    } finally {
      runner.dispose();
    }
  });

  test("a memory stop's press names it: a press on an earlier one lifts nothing; on the one held now, it asks again", async () => {
    const w = await setup();
    let asked = 0;
    const refuse = {
      reserve: async () => {
        asked += 1;
        return {
          verdict: "refuse",
          live: () => false,
          settle: () => undefined,
        };
      },
    } as never;
    const runner = w.make({ quota: () => refuse });
    try {
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      const earlier = runner.get().unrecorded.get(TASK);
      expect(earlier?.reason).toBe("storage");
      runner.tryAgain(TASK, undefined, {
        kind: "memory",
        id: earlier?.id as string,
      });
      await w.idle(runner);
      expect(asked).toBe(2);
      const now = runner.get().unrecorded.get(TASK);
      expect(now?.id).not.toBe(earlier?.id);
      runner.tryAgain(TASK, undefined, {
        kind: "memory",
        id: earlier?.id as string,
      });
      await w.idle(runner);
      expect(asked, "a press on the earlier stop asks nothing").toBe(2);
      runner.tryAgain(TASK, undefined, {
        kind: "memory",
        id: now?.id as string,
      });
      await w.idle(runner);
      expect(asked).toBe(3);
      expect(w.reads()).toBe(0);
    } finally {
      runner.dispose();
    }
  });

  test.each([
    ["a stop stands since: nothing is lifted or asked", true],
    ["none stands (control): the work is asked afresh", false],
  ])("a press made where no stop was shown: %s", async (_, stands) => {
    const w = await setup({
      ...(stands
        ? {
            seed: [
              row({
                phase: "stopped",
                read_failures: 3,
                stop: { reason: "unreachable" },
              }),
            ],
          }
        : {}),
      script: {
        positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      },
    });
    const runner = w.make();
    try {
      runner.tryAgain(TASK, TODAY, { kind: "none" });
      await w.idle(runner);
      if (stands) {
        expect(w.reads()).toBe(0);
        expect(w.stored()?.phase).toBe("stopped");
      } else expect(w.reads()).toBeGreaterThan(0);
    } finally {
      runner.dispose();
    }
  });

  test("a discovery stop written before claims is given one by the next work (nothing sent, no count changed); a press naming no claim then lifts nothing", async () => {
    const w = await setup({
      script: { positions: [UNCERTAIN, UNCERTAIN, UNCERTAIN] as never },
    });
    await seedDiscovery(w, stopEntry(null));
    const legacy = seenDiscovery(w.discovery() as MaterialiseDiscovery);
    expect(legacy).toMatchObject({ attempt: null });
    const runner = w.make();
    try {
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(w.reads()).toBe(0);
      expect(w.discovery()).toMatchObject({
        retry: 0,
        failures: 3,
        stop: { reason: "unreachable" },
        attempt: expect.any(String),
      });
      runner.tryAgain(TASK, undefined, legacy);
      await w.idle(runner);
      expect(w.reads()).toBe(0);
      runner.tryAgain(
        TASK,
        undefined,
        seenDiscovery(w.discovery() as MaterialiseDiscovery),
      );
      await w.idle(runner);
      expect(w.reads()).toBe(3);
    } finally {
      runner.dispose();
    }
  });
});

/**
 * Revision 6 (review 6 R30): what a press expects of the discovery (a stop, or NONE) is compared inside the lift's transaction, so a
 * discovery stop recorded while the press waits for the lock leaves the sequence's stop, its counters and attempt exactly as they were.
 * REVIEW6 M11 is ported verbatim (the reviewer's schedule and assertions; only formatting and imports differ).
 */
describe("REVIEW6 M11 absent discovery at retry admission", () => {
  test.each([false, true])(
    "discovery stop appears while waiting=%s",
    async (appeared) => {
      const initial = row({
        phase: "stopped",
        revision: 2,
        read_failures: 3,
        stop: { reason: "unreachable" },
      });
      const w = await setup({ seed: [initial] });
      let unlock!: () => void;
      let queued = 0;
      const hold = new Promise<void>((r) => {
        unlock = r;
      });
      const locks = {
        request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
          queued++;
          return hold.then(run);
        },
      } as unknown as LockManager;
      const runner = w.make({ locks });
      const seen = seenSequence(initial, null);
      try {
        runner.tryAgain(TASK, TODAY, seen);
        for (let i = 0; i < 100 && queued === 0; i++) {
          await w.t.settle();
          await new Promise((r) => setTimeout(r, 0));
        }
        expect(queued).toBe(1);
        expect(w.reads()).toBe(0);
        expect(w.stored()).toEqual(initial);
        if (appeared) {
          const service = w.t.env.service()!;
          expect(
            await commitMaterialiseDiscovery(service, service.capture(1), {
              task_id: TASK,
              expected: null,
              next: {
                retry: 0,
                failures: 3,
                stop: { reason: "unreachable" },
                attempt: "eeeeeeee-0000-4000-8000-000000000099",
              },
            }),
          ).toMatchObject({ kind: "applied", value: { kind: "written" } });
        }
        unlock();
        await w.idle(runner);
        if (appeared) {
          expect(w.discovery()?.stop?.reason).toBe("unreachable");
          expect(w.reads()).toBe(0);
          expect(w.stored()).toEqual(initial);
        } else {
          expect(w.reads()).toBeGreaterThan(0);
          expect(w.stored()).toBeUndefined();
        }
      } finally {
        unlock();
        runner.dispose();
      }
    },
  );
});

describe("R30: the absence a press saw, before it is queued and under the lock", () => {
  test.each([
    ["a discovery stop recorded after the screen read, before the press", true],
    ["none recorded (control): the press lifts and catches up", false],
  ])("%s", async (_, appeared) => {
    const initial = row({
      phase: "stopped",
      revision: 2,
      read_failures: 3,
      stop: { reason: "unreachable" },
    });
    const w = await setup({ seed: [initial] });
    const runner = w.make();
    const seen = seenSequence(initial, null);
    try {
      if (appeared) {
        const service = w.t.env.service() as AccountService;
        expect(
          await commitMaterialiseDiscovery(service, service.capture(1), {
            task_id: TASK,
            expected: null,
            next: {
              retry: 0,
              failures: 3,
              stop: { reason: "unreachable" },
              attempt: "eeeeeeee-0000-4000-8000-000000000098",
            },
          }),
        ).toMatchObject({ kind: "applied", value: { kind: "written" } });
      }
      runner.tryAgain(TASK, TODAY, seen);
      await w.idle(runner);
      if (appeared) {
        expect(w.discovery()?.stop?.reason).toBe("unreachable");
        expect(w.reads()).toBe(0);
        expect(w.stored()).toEqual(initial);
      } else {
        expect(w.reads()).toBeGreaterThan(0);
        expect(w.stored()).toBeUndefined();
      }
    } finally {
      runner.dispose();
    }
  });
});

/**
 * Revision 6 (review 6 R29): resuming a task's paused work never stands in for ANOTHER day asked of it; that day is admitted on its own,
 * and only the same task and day is coalesced. Paused work is kept under the day it was found to be; a press supersedes paused or
 * queued work of exactly its own day. REVIEW6 M10 is ported with one labelled ADAPTATION: the resumed day D is `submitting`, so it resends
 * its stored attempt (same key) and then reads its position (CM-440), which the verbatim script did not provide (it scripted one read for
 * D, so the read meant for the new day's discovery answered D's resend instead, reporting the new day already covered); one more read of
 * D is scripted. The premise (D parked, E asked, E unsatisfied, E's own command sent) and the assertions are kept; the original failure
 * on the revision-5 tree is preserved, and the adapted case fails there too (revision-6 evidence).
 */
describe("R29: a different day asked while other work is paused or active", () => {
  test.each([false, true])(
    "REVIEW6 M10 (ported, adapted: the resumed day's resend and its position read scripted): earlier work parked=%s",
    async (parked) => {
      const later = addDays(TODAY, 1);
      const w = await setup({
        script: {
          positions: [detail("2026-10-01", true)],
          sends: [parked ? { ok: false, kind: "not_sent" } : OK],
        },
      });
      const runner = w.make();
      try {
        runner.ensure(TASK, "draft", { throughDate: TODAY });
        await w.idle(runner);
        expect(w.sent).toHaveLength(1);
        expect(w.stored()?.phase).toBe(parked ? "submitting" : undefined);
        if (parked)
          w.script.positions.push(detail(TODAY, false), detail(TODAY, false));
        w.script.positions.push(detail(TODAY, false), detail(later, false));
        const before = w.sent.length;
        runner.ensure(TASK, "draft", { throughDate: later });
        await w.idle(runner);
        if (parked) {
          // D resumed with its own stored attempt: the same key, the same body.
          expect(w.sent[before]?.command.through_date).toBe(TODAY);
          expect(w.sent[before]?.key).toBe(w.sent[0]?.key);
        }
        expect(
          w.sent.slice(before).some((x) => x.command.through_date === later),
        ).toBe(true);
        expect(w.stored(later)).toBeUndefined();
      } finally {
        runner.dispose();
      }
    },
  );

  test.each([
    ["another day", 2],
    ["the same day (control): coalesced, resent once with its own key", 1],
  ])(
    "while a day's work is ACTIVE (its read held), %s asked",
    async (_, days) => {
      const first = addDays(TODAY, 1);
      const second = days === 2 ? addDays(TODAY, 2) : first;
      let release: (r: TasksResult<TaskDetail>) => void = () => undefined;
      const w = await setup({
        script: {
          positions: [
            () =>
              new Promise<TasksResult<TaskDetail>>((r) => {
                release = r;
              }),
            detail(first, false),
            detail(first, false),
            detail(second, false),
          ],
        },
      });
      const runner = w.make();
      try {
        runner.ensure(TASK, "draft", { throughDate: first });
        for (let i = 0; i < 100 && w.reads() < 1; i += 1) {
          await w.t.settle();
          await new Promise((r) => setTimeout(r, 0));
        }
        runner.ensure(TASK, "draft", { throughDate: second });
        release(detail("2026-10-01", true));
        await w.idle(runner);
        expect(w.sent.map((s) => s.command.through_date)).toEqual(
          days === 2 ? [first, second] : [first],
        );
      } finally {
        runner.dispose();
      }
    },
  );

  test("today found by an implicit ask, then paused: the same day asked explicitly resumes it once, with its own key (no second sequence)", async () => {
    const w = await setup({
      script: {
        positions: [detail("2026-10-01", true)],
        sends: [{ ok: false, kind: "not_sent" }],
      },
    });
    const runner = w.make();
    try {
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(w.stored()?.phase).toBe("submitting");
      w.script.positions.push(detail(TODAY, false), detail(TODAY, false));
      runner.ensure(TASK, "draft", { throughDate: TODAY });
      await w.idle(runner);
      expect(w.sent.map((s) => s.command.through_date)).toEqual([TODAY, TODAY]);
      expect(w.sent[1]?.key).toBe(w.sent[0]?.key);
      expect(w.stored()).toBeUndefined();
    } finally {
      runner.dispose();
    }
  });

  test("control: once an implicit ask found its day, the same day asked explicitly while it is worked on is not asked again (no second read; it also holds before revision 6, through `attempted`)", async () => {
    let release: (r: TasksResult<{ revision: number }>) => void = () =>
      undefined;
    const w = await setup({
      script: {
        positions: [detail("2026-10-01", true), detail(TODAY, false)],
        sends: [
          () =>
            new Promise<TasksResult<{ revision: number }>>((r) => {
              release = r;
            }),
        ],
      },
    });
    const runner = w.make();
    try {
      runner.ensure(TASK, "daily");
      for (let i = 0; i < 100 && w.sent.length < 1; i += 1) {
        await w.t.settle();
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(w.sent).toHaveLength(1);
      runner.ensure(TASK, "draft", { throughDate: TODAY });
      release(OK);
      await w.idle(runner);
      expect(w.reads()).toBe(2);
      expect(w.sent).toHaveLength(1);
      expect(w.stored()).toBeUndefined();
    } finally {
      runner.dispose();
    }
  });

  test("a press on one day leaves work paused before its day was known (another need of the task): it resumes on the next kick", async () => {
    const stoppedLater = row({
      through_date: addDays(TODAY, 3),
      sequence_generation: "later",
      phase: "stopped",
      revision: 1,
      read_failures: 3,
      stop: { reason: "unreachable" },
    });
    const w = await setup({
      seed: [stoppedLater],
      script: {
        positions: [
          { ok: false, kind: "not_sent" },
          detail("2026-10-01", true),
          detail(addDays(TODAY, 3), false),
          detail("2026-10-01", true),
          detail(TODAY, false),
        ],
      },
    });
    const runner = w.make();
    try {
      // Paused at its first read: the task's today is not known yet.
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(w.reads()).toBe(1);
      runner.tryAgain(
        TASK,
        stoppedLater.through_date,
        seenSequence(stoppedLater, null),
      );
      await w.idle(runner);
      expect(w.sent.map((s) => s.command.through_date)).toEqual([
        stoppedLater.through_date,
      ]);
      runner.kick();
      await w.idle(runner);
      expect(w.sent.map((s) => s.command.through_date)).toEqual([
        stoppedLater.through_date,
        TODAY,
      ]);
    } finally {
      runner.dispose();
    }
  });

  test("a stop of a new row the ledger refused names its day; a press on it asks that day again (its command, once admitted)", async () => {
    const refusedDay = addDays(TODAY, 1);
    let refuse = true;
    const quota = {
      reserve: async (_c: string, bytes: number) => {
        const no = refuse && bytes === SEQUENCE_ROW_BYTES;
        return {
          verdict: no ? "refuse" : "ok",
          live: () => !no,
          settle: () => undefined,
        };
      },
    } as never;
    const w = await setup({
      script: {
        positions: [
          detail("2026-10-01", true),
          detail("2026-10-01", true),
          detail(refusedDay, false),
        ],
      },
    });
    const runner = w.make({ quota: () => quota });
    try {
      runner.ensure(TASK, "draft", { throughDate: refusedDay });
      await w.idle(runner);
      const held = runner.get().unrecorded.get(TASK);
      expect(held).toMatchObject({
        reason: "storage",
        throughDate: refusedDay,
      });
      expect(w.sent).toHaveLength(0);
      refuse = false;
      runner.tryAgain(TASK, undefined, {
        kind: "memory",
        id: (held as { id: string }).id,
      });
      await w.idle(runner);
      expect(w.sent.map((s) => s.command.through_date)).toEqual([refusedDay]);
      expect(runner.get().unrecorded.has(TASK)).toBe(false);
    } finally {
      runner.dispose();
    }
  });
});

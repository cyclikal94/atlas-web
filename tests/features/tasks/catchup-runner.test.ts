// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { AccountService } from "../../../src/data/engine/account-service";
import type {
  MaterialiseDiscovery,
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import type {
  MaterialiseCommand,
  TasksApi,
  TasksResult,
} from "../../../src/features/tasks/api";
import {
  type CatchUpRunner,
  createCatchUpRunner,
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
    expect(w.discovery()).toEqual({
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
    expect(w.discovery()).toEqual({
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
    expect(w.discovery()).toEqual({
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
    const real = () => w.t.env.service() as AccountService;
    const service = () =>
      new Proxy(real(), {
        get(target, key, receiver) {
          if (key !== "commit") return Reflect.get(target, key, receiver);
          return (plan: { name: string }, input: unknown) =>
            failing && plan.name === "data.writeMaterialiseDiscovery"
              ? Promise.resolve({ kind: "failed" })
              : target.commit(plan as never, input as never);
        },
      }) as AccountService;
    const runner = w.make({ service });
    runner.ensure(TASK, "daily");
    await w.idle(runner);
    expect(w.reads()).toBe(1);
    expect(runner.get().unrecorded.get(TASK)).toEqual({
      reason: "unreachable",
    });
    expect(w.discovery()).toBeUndefined();
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

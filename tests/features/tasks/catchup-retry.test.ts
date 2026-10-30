// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DataEnv } from "../../../src/data";
import type { AccountService } from "../../../src/data/engine/account-service";
import type {
  MaterialiseDiscovery,
  MaterialiseRetry,
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import {
  call,
  type MaterialiseCommand,
  type TasksApi,
  type TasksResult,
} from "../../../src/features/tasks/api";
import {
  type CatchUpRunner,
  createCatchUpRunner,
  seenDiscovery,
  seenSequence,
} from "../../../src/features/tasks/catchup/runner";
import {
  forgetCatchUp,
  runnerOf,
} from "../../../src/features/tasks/catchup/useCatchUp";
import type { TasksEnv } from "../../../src/features/tasks/env";
import type { TaskDetail } from "../../../src/features/tasks/model/contract";
import { attemptBody } from "../../../src/features/tasks/model/materialise";
import { WINDOW_MS } from "../../../src/features/tasks/model/retry";
import { todayIn } from "../../../src/features/tasks/model/time";
import { ACCOUNT, DB, defaultsWorld } from "../../support/data/defaults-world";
import { cacheRow } from "../../support/data/rows";

/**
 * Revision 10 (Decision B, review R36; design assessment Q-M1–Q-M12): the catch-up's three callers under their durable retry schedules,
 * over the PRODUCTION W27 plans and account service on the double of IndexedDB, with a scripted `TasksApi` whose every request is logged
 * with the device clock, and waits that move that clock (or are held). Review 11's seven witnesses and three positive controls are the
 * first cases (`REVIEW11`), maintained here; the rest cover the protocol they did not. FIXTURE evidence: no backend, no browser, no real
 * reload (a reload is another runner on the same database) and no measured 180-second observation.
 */
const TASK = "aaaaaaaa-0000-4000-8000-0000000000b1";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000b2";
const ZONE = "UTC";
const NOW = Date.UTC(2026, 9, 25, 12);
const TODAY = todayIn(ZONE, NOW);

type Answer<T> = TasksResult<T> | (() => Promise<TasksResult<T>>);

const detail = (
  last: string | null,
  pending: boolean,
  task = TASK,
): TasksResult<TaskDetail> => ({
  ok: true,
  value: {
    task: cacheRow({ id: task, kind: "task", label: "Water the plants" }),
    execution: cacheRow({
      id: `${task.slice(0, -2)}e0`,
      kind: "execution",
      parent_id: task,
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
    materialisation: { last_date: last, pending },
  },
});
const OK: TasksResult<{ revision: number }> = {
  ok: true,
  value: { revision: 7 },
};
/** No cause recognised (an answer of no shape the protocol knows). */
const UNRECOGNISED = { ok: false, kind: "uncertain" } as const;

/** An HTTP failure as the production transport classifies it (the reviewer's corrected error envelope: `details` is an array). */
const http = <T>(status: number, code: string, retryAfter?: string) =>
  call<T>(
    async () => ({
      error: { code, message: "m", request_id: "req-r36", details: [] },
      response: new Response("", {
        status,
        headers: {
          "content-type": "application/json",
          ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
        },
      }),
    }),
    () => null,
  );
const TRANSIENT_500 = () => http<TaskDetail>(500, "internal_error");
const TRANSIENT_503 = () => http<TaskDetail>(503, "temporarily_unavailable");

async function setup(
  options: {
    positions?: Array<Answer<TaskDetail>>;
    sends?: Array<Answer<{ revision: number }>>;
    seed?: MaterialiseSequenceRow[];
    discovery?: Record<string, MaterialiseDiscovery>;
  } = {},
) {
  const t = await defaultsWorld({ online: false, noReader: true });
  await t.settle();
  if (options.seed) t.world.idb.seed(DB, "materialise_sequences", options.seed);
  if (options.discovery) {
    const sync = t.world.idb.peek(
      DB,
      "sync_state",
      "singleton",
    ) as SyncStateRow;
    t.world.idb.seed(DB, "sync_state", [
      { ...sync, materialise_discovery: options.discovery },
    ]);
  }
  const positions = [...(options.positions ?? [])];
  const sends = [...(options.sends ?? [])];
  let clock = NOW;
  /** Every request, with the clock when it was made. */
  const log: Array<{
    what: "read" | "send";
    at: number;
    task: string;
    key?: string;
    body?: string;
    admitted?: () => boolean;
  }> = [];
  const api = {
    readTask: async (task: string, admitted?: () => boolean) => {
      log.push({
        what: "read",
        at: clock,
        task,
        ...(admitted ? { admitted } : {}),
      });
      const next = positions.shift();
      if (next === undefined) return detail(TODAY, false, task);
      return typeof next === "function" ? next() : next;
    },
    materialise: async (command: MaterialiseCommand, key: string) => {
      log.push({
        what: "send",
        at: clock,
        task: command.task_id,
        key,
        body: JSON.stringify(command),
      });
      const next = sends.shift();
      if (next === undefined) return OK;
      return typeof next === "function" ? next() : next;
    },
  } as unknown as TasksApi;
  const waits: number[] = [];
  let online = true;
  let ids = 0;
  const make = (
    over: {
      locks?: LockManager | null;
      service?: () => AccountService | null;
      /** Replaces moving the clock by each wait (a held wait: never resolves; a jump: moves it by something else). */
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) =>
    createCatchUpRunner({
      api,
      identity: `${ACCOUNT}:1`,
      accountId: ACCOUNT,
      epoch: 1,
      service: over.service ?? (() => t.env.service()),
      online: () => online,
      writable: () => true,
      now: () => clock,
      newId: () => {
        ids += 1;
        return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`;
      },
      sleep: async (ms) => {
        waits.push(ms);
        if (over.sleep) await over.sleep(ms);
        else clock += ms;
      },
      locks: over.locks === undefined ? null : over.locks,
    });
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await t.settle();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const idle = async (runner: CatchUpRunner) => {
    for (let i = 0; i < 400; i += 1) {
      await t.settle();
      await new Promise((r) => setTimeout(r, 0));
      if (runner.get().active.length === 0 && !runner.get().waiting) {
        await t.settle();
        if (runner.get().active.length === 0) return;
      }
    }
    throw new Error("the runner never went idle");
  };
  const stored = (through = TODAY, task = TASK) =>
    t.world.idb.peek(DB, "materialise_sequences", [task, through]) as
      | MaterialiseSequenceRow
      | undefined;
  const discovery = (task = TASK) =>
    (
      t.world.idb.peek(DB, "sync_state", "singleton") as
        | SyncStateRow
        | undefined
    )?.materialise_discovery?.[task] as MaterialiseDiscovery | undefined;
  const reads = (task = TASK) =>
    log.filter((e) => e.what === "read" && e.task === task);
  const sent = (task = TASK) =>
    log.filter((e) => e.what === "send" && e.task === task);
  return {
    t,
    log,
    reads,
    sent,
    waits,
    make,
    idle,
    settle,
    stored,
    discovery,
    positions,
    sends,
    now: () => clock,
    setNow: (value: number) => {
      clock = value;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

const row = (
  over: Partial<MaterialiseSequenceRow> = {},
): MaterialiseSequenceRow => ({
  task_id: TASK,
  through_date: TODAY,
  sequence_generation: "g-r36",
  phase: "ready",
  attempt: null,
  read_seq: 0,
  successful_calls: 0,
  last_known_position: "2026-10-01",
  started_at: 1,
  read_failures: 0,
  stop: null,
  trigger: "daily",
  schedule: null,
  ...over,
});
const schedule = (over: Partial<MaterialiseRetry>): MaterialiseRetry => ({
  v: 1,
  caller: "command",
  issued: null,
  since: null,
  failures: 0,
  next: 0,
  server: null,
  cause: null,
  unknown: 0,
  seen: NOW,
  pause: null,
  ...over,
});
const offsets = (entries: Array<{ at: number }>) =>
  entries.map((e) => e.at - NOW);
/** Immediate failed answers through one window: transmissions at these offsets (ms), then a pause. */
const WINDOW_OFFSETS = [
  0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, 121_000, 151_000,
];

describe("REVIEW11: Decision B witnesses and their positive controls", () => {
  test("CONTROL: a healthy catch-up needs one command and two reads", async () => {
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.sent()).toHaveLength(1);
    expect(w.reads()).toHaveLength(2);
    expect(r.get().finished).toBe(1);
    expect(w.stored()).toBeUndefined();
    r.dispose();
  });

  test("CONTROL: slice capacity stays a definite stop; kicks and a reconnection send nothing", async () => {
    const w = await setup({
      positions: [detail("2026-10-01", true)],
      sends: [await http(503, "slice_capacity")],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.stored()?.stop?.reason).toBe("capacity");
    w.setOnline(false);
    r.kick();
    w.setOnline(true);
    r.reconnected();
    await w.idle(r);
    expect(w.sent()).toHaveLength(1);
    r.dispose();
  });

  test("CONTROL: three unrecognised first reads stop it; a reconnection, a kick or a trigger does not lift it", async () => {
    const w = await setup({
      positions: [UNRECOGNISED, UNRECOGNISED, UNRECOGNISED] as never,
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(3);
    expect(w.discovery()).toMatchObject({
      stop: { reason: "unreachable" },
      schedule: { pause: "unrecognised", unknown: 3 },
    });
    w.setOnline(false);
    r.kick();
    w.setOnline(true);
    r.reconnected();
    r.kick();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(3);
    r.dispose();
  });

  test.each([
    ["500 internal_error", TRANSIENT_500],
    ["503 temporarily_unavailable", TRANSIENT_503],
  ])(
    "WITNESS: discovery %s goes on past three, paced 1/2/4 s, and reaches the fourth read within the window",
    async (_, failure) => {
      const f = await failure();
      expect(f).toMatchObject({ retry: { cause: "transient" } });
      const w = await setup({ positions: [f, f, f, detail(TODAY, false)] });
      const r = w.make();
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(offsets(w.reads())).toEqual([0, 1_000, 3_000, 7_000]);
      expect(w.discovery()).toBeUndefined();
      r.dispose();
    },
  );

  test("WITNESS: an uncertain command is resent with the same key and body through its own window, then pauses keeping it", async () => {
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [
        ...Array.from({ length: WINDOW_OFFSETS.length }, () => UNRECOGNISED),
        OK,
      ] as never,
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(offsets(w.sent())).toEqual(WINDOW_OFFSETS);
    expect(new Set(w.sent().map((s) => s.key)).size).toBe(1);
    expect(new Set(w.sent().map((s) => s.body)).size).toBe(1);
    expect(w.sent()[0]?.body).toBe(
      JSON.stringify(JSON.parse(attemptBody(TASK, TODAY))),
    );
    expect(w.stored()).toMatchObject({
      phase: "stopped",
      stop: { reason: "unreachable" },
      attempt: { key: w.sent()[0]?.key },
      schedule: { caller: "command", pause: "window", since: NOW },
    });
    r.dispose();
  });

  test("WITNESS: after a successful command, transient position failures retry ONLY the position read; the success is never resent", async () => {
    const f = await TRANSIENT_503();
    const w = await setup({
      positions: [detail("2026-10-01", true), f, f, f, detail(TODAY, false)],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.sent()).toHaveLength(1);
    expect(w.reads()).toHaveLength(5);
    // The position caller's own pace, from its own first failure.
    const position = offsets(w.reads().slice(1));
    expect(position.map((at) => at - (position[0] as number))).toEqual([
      0, 1_000, 3_000, 7_000,
    ]);
    expect(w.stored()).toBeUndefined();
    r.dispose();
  });

  test("WITNESS: a 429's Retry-After is a minimum: the next read is no earlier than its deadline", async () => {
    const f = await http<TaskDetail>(429, "rate_limited", "60");
    const w = await setup({ positions: [f, detail(TODAY, false)] });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(offsets(w.reads())).toEqual([0, 60_000]);
    r.dispose();
  });

  test("WITNESS: a reload (another runner on the same database) keeps the durable schedule: no read before its time", async () => {
    const f = await TRANSIENT_503();
    const w = await setup({ positions: [f, detail(TODAY, false)] });
    const first = w.make({ sleep: () => new Promise(() => undefined) });
    first.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.waits.length === 0; i += 1) await w.settle();
    expect(w.waits).toEqual([1_000]);
    expect(w.discovery()?.schedule).toMatchObject({ next: NOW + 1_000 });
    first.dispose();
    w.setNow(NOW + 400);
    const second = w.make();
    second.ensure(TASK, "daily");
    await w.idle(second);
    // It waited the REMAINING 600 ms of the stored pace, then read once.
    expect(w.waits).toEqual([1_000, 600]);
    expect(offsets(w.reads())).toEqual([0, 1_000]);
    second.dispose();
  });

  test("WITNESS: a forward jump beyond the window admits no second request; it pauses", async () => {
    const w = await setup({
      positions: [await TRANSIENT_500(), detail(TODAY, false)],
    });
    const r = w.make({
      sleep: async () => {
        w.setNow(w.now() + WINDOW_MS + 1);
      },
    });
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(1);
    expect(w.discovery()).toMatchObject({
      stop: { reason: "unreachable" },
      schedule: { pause: "window" },
    });
    r.dispose();
  });
});

describe("Q-M1: each caller and cause through its window", () => {
  test.each([
    ["transient 500", () => TRANSIENT_500()],
    ["transient 503", () => TRANSIENT_503()],
    [
      "no answer (transport)",
      async () =>
        ({
          ok: false,
          kind: "uncertain",
          retry: { cause: "transport" },
        }) as const,
    ],
    ["429 without Retry-After", () => http<TaskDetail>(429, "rate_limited")],
  ])(
    "discovery, %s: reads at 1, 3, 7 … 151 s and none at 180 s or later",
    async (_, failure) => {
      const f = (await failure()) as TasksResult<TaskDetail>;
      const w = await setup({
        positions: Array.from({ length: 12 }, () => f),
      });
      const r = w.make();
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(offsets(w.reads())).toEqual(WINDOW_OFFSETS);
      expect(w.discovery()).toMatchObject({
        stop: { reason: "unreachable" },
        schedule: { pause: "window", unknown: 0 },
      });
      r.dispose();
    },
  );

  test.each([
    ["transient 500", () => http<{ revision: number }>(500, "internal_error")],
    [
      "no answer (transport)",
      async () =>
        ({
          ok: false,
          kind: "uncertain",
          retry: { cause: "transport" },
        }) as const,
    ],
    [
      "429 without Retry-After",
      () => http<{ revision: number }>(429, "rate_limited"),
    ],
  ])("the command, %s: the same key through its window", async (_, failure) => {
    const f = (await failure()) as TasksResult<{ revision: number }>;
    const w = await setup({
      positions: [detail("2026-10-01", true)],
      sends: Array.from({ length: 12 }, () => f),
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(offsets(w.sent())).toEqual(WINDOW_OFFSETS);
    expect(new Set(w.sent().map((s) => s.key)).size).toBe(1);
    expect(w.stored()).toMatchObject({ schedule: { pause: "window" } });
    r.dispose();
  });

  test("the position read, transient: its own window from its own first failure, one command in all", async () => {
    const f = await TRANSIENT_500();
    const w = await setup({
      positions: [
        detail("2026-10-01", true),
        ...Array.from({ length: 12 }, () => f),
      ],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    const position = offsets(w.reads().slice(1));
    expect(position.map((at) => at - (position[0] as number))).toEqual(
      WINDOW_OFFSETS,
    );
    expect(w.sent()).toHaveLength(1);
    expect(w.stored()).toMatchObject({
      phase: "stopped",
      attempt: null,
      read_seq: 1,
      schedule: { caller: "position", pause: "window" },
    });
    r.dispose();
  });
});

describe("Q-M2: the unrecognised read streak belongs to its caller", () => {
  test("unknown, transient, unknown, another task's success, unknown: the third unknown stops it; transient answers and others' success do not end the streak", async () => {
    const t503 = await TRANSIENT_503();
    // Another task (another caller) is read while this one waits for its pace: its success comes between this task's answers.
    const w = await setup({
      positions: [
        UNRECOGNISED,
        detail(TODAY, false, OTHER),
        t503,
        UNRECOGNISED,
        UNRECOGNISED,
      ] as never,
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    r.ensure(OTHER, "daily");
    await w.idle(r);
    expect(w.log.map((e) => e.task)).toEqual([TASK, OTHER, TASK, TASK, TASK]);
    expect(w.reads(OTHER)).toHaveLength(1);
    expect(w.discovery(OTHER)).toBeUndefined();
    expect(w.discovery()).toMatchObject({
      stop: { reason: "unreachable" },
      schedule: { pause: "unrecognised", unknown: 3, failures: 4 },
    });
    expect(w.reads()).toHaveLength(4);
    r.dispose();
  });

  test("control: the caller's own success ends its streak (two unknown reads, a success, two more unknown: no stop)", async () => {
    const w = await setup({
      positions: [
        UNRECOGNISED,
        UNRECOGNISED,
        detail("2026-10-01", true),
        UNRECOGNISED,
        UNRECOGNISED,
        detail(TODAY, false),
      ] as never,
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    // The discovery's success ended its streak; the two unknown reads after it are the POSITION caller's own (a new streak).
    expect(w.sent()).toHaveLength(1);
    expect(w.reads()).toHaveLength(6);
    expect(w.stored()).toBeUndefined();
    expect(w.discovery()).toBeUndefined();
    r.dispose();
  });

  test("an unrecognised COMMAND answer is duration-governed: ten sends, never a stop at three", async () => {
    const w = await setup({
      positions: [detail("2026-10-01", true)],
      sends: Array.from({ length: 12 }, () => UNRECOGNISED) as never,
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.sent()).toHaveLength(WINDOW_OFFSETS.length);
    expect(w.stored()?.schedule).toMatchObject({ unknown: 0, pause: "window" });
    r.dispose();
  });
});

describe("Q-M3: server deadlines through every entry path", () => {
  test("a deadline longer than the back-off governs, a shorter one does not; the person's Try again and a reconnection before it send nothing", async () => {
    const long = await http<{ revision: number }>(429, "rate_limited", "90");
    const short = await http<{ revision: number }>(429, "rate_limited", "0");
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [short, long, ...Array.from({ length: 12 }, () => long)],
    });
    // Waits are held: the deadline is observed before anything else happens.
    const held: Array<() => void> = [];
    const r = w.make({
      sleep: (ms) =>
        new Promise<void>((resolve) =>
          held.push(() => {
            w.setNow(w.now() + ms);
            resolve();
          }),
        ),
    });
    r.ensure(TASK, "daily");
    for (let i = 0; i < 100 && held.length === 0; i += 1) await w.settle();
    // The 0-second Retry-After: the back-off's 1 s.
    expect(w.waits).toEqual([1_000]);
    held.shift()?.();
    for (let i = 0; i < 100 && held.length === 0; i += 1) await w.settle();
    expect(offsets(w.sent())).toEqual([0, 1_000]);
    // The 90-second deadline, not the back-off's 2 s.
    expect(w.waits).toEqual([1_000, 90_000]);
    const before = w.sent().length;
    // Neither a reconnection nor a kick before the deadline sends anything (they are not stops to lift; the schedule holds the work).
    w.setOnline(false);
    r.kick();
    w.setOnline(true);
    r.reconnected();
    r.kick();
    await w.settle();
    expect(w.sent()).toHaveLength(before);
    r.dispose();
  });

  test("a deadline beyond the window pauses at once; Try again keeps the deadline: nothing is sent before it, then once", async () => {
    const far = await http<TaskDetail>(429, "rate_limited", "600");
    const w = await setup({ positions: [far, detail(TODAY, false)] });
    const r = w.make({ sleep: () => new Promise(() => undefined) });
    r.ensure(TASK, "daily");
    // Its answer is recorded (a stop, or, were the deadline ignored, a wait for the back-off): the outcome is asserted, not waited on.
    for (
      let i = 0;
      i < 100 && w.discovery()?.stop == null && w.waits.length === 0;
      i += 1
    )
      await w.settle();
    const entry = w.discovery() as MaterialiseDiscovery;
    expect(w.waits).toEqual([]);
    expect(entry).toMatchObject({
      stop: { reason: "unreachable" },
      schedule: { pause: "window", server: NOW + 600_000 },
    });
    await w.idle(r);
    // A reconnection lifts the window pause, but the deadline stands: the work waits for it.
    w.setNow(NOW + 5_000);
    r.reconnected();
    for (let i = 0; i < 100 && w.waits.length === 0; i += 1) await w.settle();
    expect(w.reads()).toHaveLength(1);
    expect(w.waits).toEqual([595_000]);
    expect(w.discovery()).toMatchObject({
      stop: null,
      schedule: { next: NOW + 600_000, server: NOW + 600_000 },
    });
    r.dispose();
    // The person's press on a fresh page likewise waits for it.
    w.setNow(NOW + 6_000);
    const second = w.make();
    second.ensure(TASK, "daily");
    await w.idle(second);
    expect(offsets(w.reads())).toEqual([0, 600_000]);
    expect(w.discovery()).toBeUndefined();
    second.dispose();
  });
});

describe("Q-M4: reload and takeover in each caller's state", () => {
  test("submitting with a future schedule: a new runner sends nothing before it, then the SAME key once", async () => {
    const key = "kept-r36";
    const w = await setup({
      seed: [
        row({
          phase: "submitting",
          attempt: { key, body: attemptBody(TASK, TODAY) },
          read_failures: 2,
          schedule: schedule({
            since: NOW - 3_000,
            failures: 2,
            next: NOW + 4_000,
            cause: "transient",
            seen: NOW - 3_000,
          }),
        }),
      ],
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.waits).toEqual([4_000]);
    expect(w.sent().map((s) => [s.at - NOW, s.key])).toEqual([[4_000, key]]);
    expect(w.stored()).toBeUndefined();
    r.dispose();
  });

  test("awaiting its position with a future schedule: a new runner reads the discovery, then the position only at its time; never a command", async () => {
    const w = await setup({
      seed: [
        row({
          phase: "awaiting_position_read",
          read_seq: 1,
          read_failures: 1,
          schedule: schedule({
            caller: "position",
            since: NOW - 500,
            failures: 1,
            next: NOW + 500,
            cause: "transient",
            seen: NOW - 500,
          }),
        }),
      ],
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    // The discovery read is its own caller's; it neither stands in for the position read nor resets its schedule.
    expect(offsets(w.reads())).toEqual([0, 500]);
    expect(w.sent()).toEqual([]);
    expect(w.stored()).toBeUndefined();
    r.dispose();
  });

  test("two runners sharing one lock: the second, taking over after the first ends, keeps the first's schedule", async () => {
    let holder: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
        const mine = holder.then(() => run());
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    const f = await http<{ revision: number }>(500, "internal_error");
    const w = await setup({
      positions: [
        detail("2026-10-01", true),
        detail("2026-10-01", true),
        detail(TODAY, false),
      ],
      sends: [f, f, OK],
    });
    const a = w.make({ locks, sleep: () => new Promise(() => undefined) });
    a.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.waits.length === 0; i += 1) await w.settle();
    expect(w.sent()).toHaveLength(1);
    a.dispose();
    const b = w.make({ locks });
    b.ensure(TASK, "daily");
    await w.idle(b);
    expect(offsets(w.sent())).toEqual([0, 1_000, 3_000]);
    expect(new Set(w.sent().map((s) => s.key)).size).toBe(1);
    b.dispose();
  });
});

describe("Q-M5: boundaries, clocks and held calls", () => {
  test("a backwards clock pauses the caller (clock) and sends nothing; Try again starts from the clock as it is", async () => {
    const w = await setup({ positions: [await TRANSIENT_503()] });
    const r = w.make({ sleep: () => new Promise(() => undefined) });
    r.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.waits.length === 0; i += 1) await w.settle();
    r.dispose();
    w.setNow(NOW - 60_000);
    const second = w.make();
    second.ensure(TASK, "daily");
    await w.idle(second);
    expect(w.reads()).toHaveLength(1);
    const entry = w.discovery() as MaterialiseDiscovery;
    expect(entry).toMatchObject({
      stop: { reason: "unreachable" },
      schedule: { pause: "clock" },
    });
    second.tryAgain(TASK, undefined, seenDiscovery(entry));
    await w.idle(second);
    expect(w.reads()).toHaveLength(2);
    expect(w.discovery()).toBeUndefined();
    second.dispose();
  });

  test("an untrusted stored schedule grants no fresh budget: it is stopped (clock), nothing read", async () => {
    const w = await setup({
      discovery: {
        [TASK]: {
          retry: 0,
          failures: 1,
          stop: null,
          attempt: "a-1",
          schedule: { ...schedule({ caller: "discovery" }), next: -1 },
        },
      },
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(0);
    expect(w.discovery()).toMatchObject({
      stop: { reason: "unreachable" },
      failures: 1,
      schedule: { pause: "clock" },
    });
    r.dispose();
  });

  test("a call issued before the window's end and answered after it is recorded once, never resent or called failed for the clock alone", async () => {
    let answer!: (r: TasksResult<{ revision: number }>) => void;
    const f = await http<{ revision: number }>(500, "internal_error");
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [
        f,
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    for (let i = 0; i < 100 && w.sent().length < 2; i += 1) await w.settle();
    expect(offsets(w.sent())).toEqual([0, 1_000]);
    // The held call outlives the window; then it succeeds.
    w.setNow(NOW + WINDOW_MS + 30_000);
    answer(OK);
    await w.idle(r);
    expect(w.sent()).toHaveLength(2);
    expect(w.stored()).toBeUndefined();
    r.dispose();
  });

  test("a resend the session holds back is not made once the window has ended while it waited", async () => {
    const f = await TRANSIENT_500();
    let predicate: (() => boolean) | undefined;
    const w = await setup({
      positions: [
        f,
        async () => {
          const entry = w.reads().at(-1);
          predicate = entry?.admitted;
          return { ok: false, kind: "not_sent" } as const;
        },
      ],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(predicate?.()).toBe(true);
    w.setNow(NOW + WINDOW_MS);
    expect(predicate?.()).toBe(false);
    // Not sent after all: its admission is withdrawn, the count it had is kept.
    expect(w.discovery()).toMatchObject({
      stop: null,
      failures: 1,
      schedule: { issued: null, failures: 1 },
    });
    r.dispose();
  });
});

describe("Q-M6/Q-M7: an observed reconnection resumes a window pause only, once", () => {
  async function windowStopped() {
    const f = await TRANSIENT_500();
    const w = await setup({
      positions: [
        ...Array.from({ length: WINDOW_OFFSETS.length }, () => f),
        detail(TODAY, false),
      ],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.discovery()?.schedule?.pause).toBe("window");
    return { w, r };
  }

  test("a kick, an ensure and the page's first online render do not resume it; a reconnection does, once", async () => {
    const { w, r } = await windowStopped();
    const before = w.reads().length;
    r.kick();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(before);
    r.reconnected();
    await w.idle(r);
    expect(w.reads()).toHaveLength(before + 1);
    expect(w.discovery()).toBeUndefined();
    // A repeated reconnection finds nothing to lift.
    r.reconnected();
    await w.idle(r);
    expect(w.reads()).toHaveLength(before + 1);
    r.dispose();
  });

  test("two pages consume the same reconnection: ONE resumed episode", async () => {
    let holder: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (_n: string, _o: unknown, run: () => Promise<unknown>) => {
        const mine = holder.then(() => run());
        holder = mine.catch(() => undefined);
        return mine;
      },
    } as unknown as LockManager;
    const f = await TRANSIENT_500();
    const w = await setup({
      positions: Array.from({ length: 3 * WINDOW_OFFSETS.length }, () => f),
    });
    const a = w.make({ locks });
    a.ensure(TASK, "daily");
    await w.idle(a);
    const before = w.reads().length;
    expect(before).toBe(WINDOW_OFFSETS.length);
    const b = w.make({ locks });
    a.reconnected();
    b.reconnected();
    await w.idle(a);
    await w.idle(b);
    // One more window, not two.
    expect(w.reads().length - before).toBe(WINDOW_OFFSETS.length);
    expect(w.discovery()).toMatchObject({
      retry: 1,
      schedule: { pause: "window" },
    });
    a.dispose();
    b.dispose();
  });

  test("a day's command paused by its window resumes on a reconnection WHERE it stopped: its calls kept, the same key", async () => {
    const key = "kept-online";
    const w = await setup({
      seed: [
        row({
          phase: "stopped",
          attempt: { key, body: attemptBody(TASK, TODAY) },
          successful_calls: 5,
          read_failures: 10,
          stop: { reason: "unreachable" },
          schedule: schedule({
            since: NOW - WINDOW_MS,
            failures: 10,
            next: NOW + 30_000,
            cause: "transient",
            pause: "window",
            seen: NOW - 29_000,
          }),
        }),
      ],
      positions: [detail("2026-10-01", true), detail("2026-10-17", true)],
      // The next command is held, so the row is observed after the resumed one's position read.
      sends: [OK, () => new Promise(() => undefined)],
    });
    const r = w.make();
    r.reconnected();
    for (let i = 0; i < 100 && w.sent().length < 2; i += 1) await w.settle();
    expect(w.sent()[0]?.key).toBe(key);
    // Its sixth counted call (the budget was not reset by the reconnection), then the next command with a fresh key.
    expect(w.stored()).toMatchObject({
      phase: "submitting",
      successful_calls: 6,
    });
    expect(w.sent()[1]?.key).not.toBe(key);
    r.dispose();
  });

  test.each(["unrecognised", "clock", "legacy"] as const)(
    "a %s pause, and stops that are not retry pauses, are not resumed by a reconnection",
    async (pause) => {
      const w = await setup({
        seed: [
          row({
            phase: "stopped",
            attempt: { key: "k", body: attemptBody(TASK, TODAY) },
            stop: { reason: "unreachable" },
            schedule: schedule({ pause, seen: NOW - 1 }),
          }),
          row({
            through_date: "2026-10-26",
            phase: "stopped",
            stop: { reason: "bound" },
          }),
          row({
            through_date: "2026-10-27",
            phase: "stopped",
            stop: { reason: "capacity" },
          }),
        ],
      });
      const r = w.make();
      r.reconnected();
      await w.idle(r);
      expect(w.log).toEqual([]);
      r.dispose();
    },
  );

  test("Q-M7: a stop that came back after another page's reset is not lifted by the earlier reconnection's view", async () => {
    const { w, r } = await windowStopped();
    const seen = w.discovery() as MaterialiseDiscovery;
    // Another page lifted it and it stopped again (a new retry): a press or reconnection naming the first stop lifts nothing.
    const before = w.reads().length;
    r.tryAgain(TASK, undefined, seenDiscovery(seen));
    await w.idle(r);
    expect(w.reads().length).toBeGreaterThan(before);
    const after = w.reads().length;
    r.tryAgain(TASK, undefined, seenDiscovery(seen));
    await w.idle(r);
    expect(w.reads()).toHaveLength(after);
    r.dispose();
  });
});

describe("Q-M8: callers and days stay their own", () => {
  test("a paused day keeps its attempt and deadline while another day and another task are caught up", async () => {
    const key = "day-d";
    const paused = row({
      through_date: "2026-10-24",
      phase: "stopped",
      attempt: { key, body: attemptBody(TASK, "2026-10-24") },
      stop: { reason: "unreachable" },
      schedule: schedule({
        since: NOW - 1_000,
        failures: 1,
        next: NOW + 60_000,
        server: NOW + 60_000,
        cause: "rate_limited",
        pause: "unrecognised",
        seen: NOW - 1_000,
      }),
    });
    const w = await setup({
      seed: [paused],
      positions: [
        detail("2026-10-01", true),
        detail(TODAY, false),
        detail(TODAY, false, OTHER),
      ],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    r.ensure(OTHER, "daily");
    await w.idle(r);
    // Today's own position read found the earlier day unsatisfied? It covers it (TODAY ≥ the 24th): that row is satisfied and removed.
    // The control below keeps it unsatisfied instead.
    expect(w.stored("2026-10-24")).toBeUndefined();
    r.dispose();

    const w2 = await setup({
      seed: [paused],
      // Today's command does not move the position (no progress, a stop): nothing covers the 24th.
      positions: [
        detail("2026-10-01", true),
        detail("2026-10-01", true),
        detail(TODAY, false, OTHER),
      ],
      sends: [OK],
    });
    const r2 = w2.make();
    r2.ensure(TASK, "daily");
    r2.ensure(OTHER, "daily");
    await w2.idle(r2);
    expect(w2.sent().every((s) => s.key !== key)).toBe(true);
    expect(w2.stored("2026-10-24")).toEqual(
      expect.objectContaining({
        attempt: paused.attempt,
        schedule: paused.schedule,
        stop: paused.stop,
      }),
    );
    expect(w2.discovery(OTHER)).toBeUndefined();
    r2.dispose();
  });
});

describe("Q-M9: storage failures at each write admit no automatic transmission", () => {
  type Write = { next?: unknown; expected?: unknown };
  function failing(
    w: Awaited<ReturnType<typeof setup>>,
    fails: (plan: string, input: Write) => boolean,
  ) {
    const real = w.t.env.service() as AccountService;
    return new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "commit") return Reflect.get(target, key, receiver);
        return (plan: { name: string }, input: Write) =>
          fails(plan.name, input)
            ? Promise.resolve({ kind: "failed" })
            : target.commit(plan as never, input as never);
      },
    }) as AccountService;
  }
  const issuing = (input: Write) =>
    (input.next as { schedule?: { issued?: number | null } } | null)?.schedule
      ?.issued != null;

  test("I2: a lost admission (another page's issue won the compare-and-set) transmits nothing; the other page's issue is what stands", async () => {
    const w = await setup({
      seed: [row()],
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    const real = w.t.env.service() as AccountService;
    let raced = false;
    const service = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "commit") return Reflect.get(target, key, receiver);
        return async (plan: { name: string }, input: Write) => {
          const next = input.next as MaterialiseSequenceRow | null;
          if (
            raced ||
            plan.name !== "data.writeMaterialiseSequence" ||
            next?.schedule?.issued == null
          )
            return target.commit(plan as never, input as never);
          raced = true;
          // Another page's admission of its own attempt lands first; this page's write is stale and adopts it.
          const other = await target.commit(
            plan as never,
            {
              ...input,
              next: {
                ...next,
                attempt: { key: "other-page", body: next.attempt?.body },
              },
            } as never,
          );
          return {
            kind: "applied",
            value: {
              kind: "stale",
              stored: (other as { value: { stored: unknown } }).value.stored,
            },
          };
        };
      },
    }) as AccountService;
    const r = w.make({ service: () => service });
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(raced).toBe(true);
    // Nothing was sent on the lost admission: the other page's issue, never answered here, is counted as lost and resent at its pace.
    expect(w.sent().map((s) => [s.at - NOW, s.key])).toEqual([
      [1_000, "other-page"],
    ]);
    r.dispose();
  });

  test("a failed admission sends nothing (the command, and the discovery read)", async () => {
    const w = await setup({ positions: [detail("2026-10-01", true)] });
    const service = failing(
      w,
      (plan, input) =>
        plan === "data.writeMaterialiseSequence" && issuing(input),
    );
    const r = w.make({ service: () => service });
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.sent()).toEqual([]);
    r.dispose();
    const w2 = await setup();
    const service2 = failing(
      w2,
      (plan, input) =>
        plan === "data.writeMaterialiseDiscovery" && issuing(input),
    );
    const r2 = w2.make({ service: () => service2 });
    r2.ensure(TASK, "daily");
    await w2.idle(r2);
    expect(w2.reads()).toEqual([]);
    r2.dispose();
  });

  test.each([
    [
      "a failed command's record",
      "send",
      () => http<{ revision: number }>(500, "internal_error"),
    ],
    ["a successful command's record", "send", async () => OK],
  ] as const)(
    "%s cannot be written: a storage stop in this page's memory; kicks, triggers and a reconnection send nothing more; the row keeps its issue",
    async (_, what, answer) => {
      const w = await setup({
        positions: [detail("2026-10-01", true)],
        sends: [(await answer()) as TasksResult<{ revision: number }>],
      });
      const service = failing(
        w,
        (plan, input) =>
          plan === "data.writeMaterialiseSequence" &&
          !issuing(input) &&
          (input.expected as { phase?: string } | null)?.phase === "submitting",
      );
      const r = w.make({ service: () => service });
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.log.filter((e) => e.what === what)).toHaveLength(1);
      expect(r.get().unrecorded.get(TASK)).toMatchObject({
        reason: "storage",
        throughDate: TODAY,
      });
      expect(w.stored()?.schedule?.issued).toBe(NOW);
      r.kick();
      r.ensure(TASK, "daily");
      r.reconnected();
      await w.idle(r);
      expect(w.sent()).toHaveLength(1);
      r.dispose();
    },
  );

  test("a failed discovery's record, and a found discovery's removal: storage stops in memory; nothing more is read", async () => {
    for (const found of [false, true]) {
      const w = await setup({
        positions: [found ? detail("2026-10-01", true) : await TRANSIENT_503()],
      });
      const service = failing(
        w,
        (plan, input) =>
          plan === "data.writeMaterialiseDiscovery" && !issuing(input),
      );
      const r = w.make({ service: () => service });
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(1);
      expect(r.get().unrecorded.has(TASK)).toBe(true);
      r.kick();
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(1);
      expect(w.sent()).toEqual([]);
      r.dispose();
    }
  });
});

describe("Q-M11: records of earlier builds", () => {
  test("a discovery entry with failures and no schedule is stopped for the person (legacy), nothing read, its count kept; Try again reads", async () => {
    const w = await setup({
      discovery: {
        [TASK]: { retry: 2, failures: 2, stop: null, attempt: "old-claim" },
      },
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toEqual([]);
    const entry = w.discovery() as MaterialiseDiscovery;
    expect(entry).toMatchObject({
      retry: 2,
      failures: 2,
      stop: { reason: "unreachable" },
      attempt: "old-claim",
      schedule: { pause: "legacy", since: null },
    });
    r.tryAgain(TASK, undefined, seenDiscovery(entry));
    await w.idle(r);
    expect(w.reads()).toHaveLength(1);
    expect(w.discovery()).toBeUndefined();
    r.dispose();
  });

  test("a stopped legacy row keeps its stop and consent; a legacy position read that had failed is stopped, and its press reads (never a command)", async () => {
    const stopped = row({
      phase: "stopped",
      stop: { reason: "bound" },
      successful_calls: 8,
    });
    delete (stopped as Partial<MaterialiseSequenceRow>).schedule;
    const w = await setup({ seed: [stopped] });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.stored()).toEqual(stopped);
    r.dispose();

    const reading = row({
      phase: "awaiting_position_read",
      read_seq: 2,
      read_failures: 2,
    });
    delete (reading as Partial<MaterialiseSequenceRow>).schedule;
    const w2 = await setup({
      seed: [reading],
      positions: [
        detail("2026-10-01", true),
        detail("2026-10-01", true),
        detail(TODAY, false),
      ],
    });
    const r2 = w2.make();
    r2.ensure(TASK, "daily");
    await w2.idle(r2);
    const held = w2.stored() as MaterialiseSequenceRow;
    expect(held).toMatchObject({
      phase: "stopped",
      read_seq: 2,
      read_failures: 2,
      schedule: { caller: "position", pause: "legacy" },
    });
    r2.tryAgain(TASK, TODAY, seenSequence(held, null));
    await w2.idle(r2);
    expect(w2.sent()).toEqual([]);
    expect(w2.stored()).toBeUndefined();
    r2.dispose();
  });
});

describe("Q-M12: the success/read split and the existing gates", () => {
  test("a success followed by a paused position read, then Try again: the read only, its calls counted once, no extra command", async () => {
    const f = await TRANSIENT_500();
    const w = await setup({
      positions: [
        detail("2026-10-01", true),
        ...Array.from({ length: WINDOW_OFFSETS.length }, () => f),
        detail("2026-10-01", true),
        detail("2026-10-17", true),
      ],
      sends: [OK, OK],
    });
    const r = w.make();
    r.ensure(TASK, "daily");
    await w.idle(r);
    const held = w.stored() as MaterialiseSequenceRow;
    expect(held).toMatchObject({
      phase: "stopped",
      attempt: null,
      read_seq: 1,
      successful_calls: 0,
      schedule: { caller: "position", pause: "window" },
    });
    expect(w.sent()).toHaveLength(1);
    r.tryAgain(TASK, TODAY, seenSequence(held, null));
    for (let i = 0; i < 100 && w.sent().length < 2; i += 1) await w.settle();
    // The press read the position (the success counted), then the next command went out.
    expect(w.sent()).toHaveLength(2);
    expect(w.sent()[1]?.key).not.toBe(w.sent()[0]?.key);
    r.dispose();
  });
});

describe("Q-M6 (production hook): only an observed offline-to-online change is a reconnection", () => {
  afterEach(() => forgetCatchUp());
  const env = (online: boolean, over: Partial<TasksEnv> = {}): TasksEnv => ({
    api: {} as TasksApi,
    accountId: ACCOUNT,
    identity: `${ACCOUNT}:1`,
    online,
    writable: true,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    dailyPageSize: 200,
    ...over,
  });
  const data = {
    service: () => null,
    serviceStore: { get: () => null, subscribe: () => () => undefined },
  } as unknown as DataEnv;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("the first render online, a repeated online render and other changes are kicks; offline then online is a reconnection, once", async () => {
    const runner = runnerOf(env(true), data);
    const reconnected = vi.spyOn(runner, "reconnected");
    const kick = vi.spyOn(runner, "kick");
    runnerOf(env(true), data);
    await flush();
    expect([reconnected.mock.calls.length, kick.mock.calls.length]).toEqual([
      0, 0,
    ]);
    runnerOf(env(true, { writable: false }), data);
    await flush();
    expect([reconnected.mock.calls.length, kick.mock.calls.length]).toEqual([
      0, 1,
    ]);
    runnerOf(env(false, { writable: false }), data);
    await flush();
    expect([reconnected.mock.calls.length, kick.mock.calls.length]).toEqual([
      0, 2,
    ]);
    runnerOf(env(true, { writable: false }), data);
    await flush();
    expect([reconnected.mock.calls.length, kick.mock.calls.length]).toEqual([
      1, 2,
    ]);
    runnerOf(env(true, { writable: false }), data);
    runnerOf(env(true), data);
    await flush();
    expect([reconnected.mock.calls.length, kick.mock.calls.length]).toEqual([
      1, 3,
    ]);
  });

  test("a page that starts offline and goes online observed the change; a page that starts online did not", async () => {
    const offline = runnerOf(env(false), data);
    const first = vi.spyOn(offline, "reconnected");
    runnerOf(env(true), data);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    forgetCatchUp();
    const online = runnerOf(env(true), data);
    const second = vi.spyOn(online, "reconnected");
    runnerOf(env(true), data);
    await flush();
    expect(second).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DataEnv } from "../../../src/data";
import type { AccountService } from "../../../src/data/engine/account-service";
import type { WriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import { createWriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import {
  createPageDataHost,
  resetPageDataHost,
} from "../../../src/data/leader/page-host";
import type {
  MaterialiseDiscovery,
  MaterialiseRetry,
  MaterialiseSequenceRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import {
  call,
  createTasksApi,
  type MaterialiseCommand,
  type TasksApi,
  type TasksResult,
} from "../../../src/features/tasks/api";
import {
  createPageLifecycle,
  type PageLifecycle,
} from "../../../src/features/tasks/catchup/lifecycle";
import {
  type CatchUpRunner,
  createCatchUpRunner,
  fenceOf,
  REPAIR_MS,
  seenDiscovery,
  seenSequence,
} from "../../../src/features/tasks/catchup/runner";
import {
  forgetCatchUp,
  runnerOf,
} from "../../../src/features/tasks/catchup/useCatchUp";
import type { TasksEnv } from "../../../src/features/tasks/env";
import {
  parseTaskDetail,
  type TaskDetail,
} from "../../../src/features/tasks/model/contract";
import { attemptBody } from "../../../src/features/tasks/model/materialise";
import { WINDOW_MS } from "../../../src/features/tasks/model/retry";
import {
  addDays,
  dayEnd,
  todayIn,
} from "../../../src/features/tasks/model/time";
import { createApiClient } from "../../../src/lib/api-client";
import { type Session, StampedRequestError } from "../../../src/session";
import { ACCOUNT, DB, defaultsWorld } from "../../support/data/defaults-world";
import { FakeMarkerStorage } from "../../support/data/marker-storage";
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
      /** Revision 11: the page's write-failure markers (none when omitted). */
      markers?: WriteFailureMarkers;
      /** Revision 11: the API this runner uses instead of the scripted one (the production client over a session double). */
      api?: TasksApi;
      /** Revision 15 (R36-H/I): the page's lifecycle (`pageLife`); none: never torn down. */
      lifecycle?: PageLifecycle;
    } = {},
  ) =>
    createCatchUpRunner({
      ...(over.markers === undefined
        ? {}
        : { markers: () => over.markers as WriteFailureMarkers }),
      ...(over.lifecycle === undefined ? {} : { lifecycle: over.lifecycle }),
      api: over.api ?? api,
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

// ---- Revision 11 (review R36; design assessment C1–C4, Q1–Q11) ----------------------------------------------------------------------
/**
 * Review 12's four R36 witnesses with their positive controls, maintained (`REVIEW12`), and the schedules the design assessment adds
 * around each boundary. The production runner, W27 plans and account service throughout; only the commit boundary, the API's answers
 * (or, for the transport cases, the session under the production task client) and the clock are scripted. FIXTURE evidence.
 */
type Commit = { next?: unknown; expected?: unknown };
/** The production service with its `commit` intercepted: `onCommit` decides when (and whether) the real commit runs. */
function intercepted(
  w: Awaited<ReturnType<typeof setup>>,
  onCommit: (
    plan: string,
    input: Commit,
    run: () => Promise<unknown>,
  ) => Promise<unknown>,
): AccountService {
  const real = w.t.env.service() as AccountService;
  return new Proxy(real, {
    get(target, key, receiver) {
      if (key !== "commit") return Reflect.get(target, key, receiver);
      return (plan: { name: string }, input: Commit) =>
        onCommit(plan.name, input, () =>
          target.commit(plan as never, input as never),
        );
    },
  }) as AccountService;
}
/** The write admits a transmission (its schedule's `issued` is set). */
const admitting = (input: Commit) =>
  (input.next as { schedule?: { issued?: number | null } } | null)?.schedule
    ?.issued != null;
const PLAN_OF = {
  discovery: "data.writeMaterialiseDiscovery",
  command: "data.writeMaterialiseSequence",
  position: "data.writeMaterialiseSequence",
} as const;
const CALLERS = ["discovery", "command", "position"] as const;
type CallerName = (typeof CALLERS)[number];
/** The caller's state one second before its window ends (`since` = NOW − WINDOW + 1 s), as seeded. */
function oneSecondLeft(caller: CallerName) {
  const s = schedule({
    caller,
    since: NOW - WINDOW_MS + 1_000,
    failures: 1,
    // Its time came 10 s ago and it was last written now: a clock moved back between them is told apart from one before `next`.
    next: NOW - 10_000,
    seen: NOW,
  });
  return caller === "discovery"
    ? {
        discovery: {
          [TASK]: {
            retry: 0,
            failures: 1,
            stop: null,
            attempt: "old",
            schedule: s,
          },
        },
        positions: [detail(TODAY, false)],
      }
    : {
        seed: [
          row({
            phase:
              caller === "command" ? "submitting" : "awaiting_position_read",
            attempt:
              caller === "command"
                ? { key: "frozen-key", body: attemptBody(TASK, TODAY) }
                : null,
            read_seq: caller === "position" ? 1 : 0,
            schedule: s,
          }),
        ],
        positions: [detail("2026-10-01", true), detail(TODAY, false)],
      };
}
const transmissionsOf = (
  w: Awaited<ReturnType<typeof setup>>,
  caller: CallerName,
) =>
  caller === "command"
    ? w.sent()
    : caller === "position"
      ? w.reads().slice(1)
      : w.reads();
/**
 * Revision 15 (review 16's R36-H/I): a page's lifecycle as the runner reads it (`CatchUpDeps.lifecycle`): the PRODUCTION per-call model
 * (`createPageLifecycle`) driven by the test. `hide` is the page's departure (its `pagehide`: closed, reloaded, navigated away from; the
 * browser cancels its calls); `show` its `pageshow` (a back-forward restore). Revision 16 (review 17's R36-J; design assessment Q2): `hide`
 * was revision 15's single `teardown` (a `beforeunload` or a `pagehide`); it is now the `pagehide` only, and `leave` the `beforeunload`
 * (an attempted departure, which a page that goes on outlives). The cases that meant a departure keep their meaning.
 */
const pageLife = () => {
  let dispatching = false;
  const l = createPageLifecycle({ dispatching: () => dispatching });
  return {
    lifecycle: l.lifecycle,
    hide: l.pagehide,
    leave: l.beforeunload,
    show: l.pageshow,
    /**
     * Revision 16 (review 17's R36-J; Kieran's D1 decision): a `pagehide` being dispatched (`true`) or over (`false`): what the page's
     * `window.event` tells the production lifecycle, as when Chromium delivers its cancellation between the page's `pagehide` listeners.
     */
    dispatch: (on: boolean) => {
      dispatching = on;
    },
  };
};
type Life = ReturnType<typeof pageLife>;
const markerWorld = () => {
  const storage = new FakeMarkerStorage();
  return {
    storage,
    page: (id: string) =>
      createWriteFailureMarkers(storage, undefined, {
        locks: null,
        id: () => id,
      }),
  };
};

describe("REVIEW12 R36-1: a call is permitted when it is issued, not only when it was planned", () => {
  test.each(
    CALLERS.flatMap((caller) => [
      [caller, 500, 1],
      [caller, 1_000, 0],
      [caller, 1_001, 0],
    ]) as Array<[CallerName, number, number]>,
  )(
    "%s: its admission's commit delayed until +%i ms (the window ends at +1,000): %i transmissions; a refused one is paused, its identity kept",
    async (caller, delay, expected) => {
      const w = await setup(oneSecondLeft(caller));
      let crossed = false;
      const service = intercepted(w, async (plan, input, run) => {
        const next = input.next as { schedule?: { caller?: string } } | null;
        if (
          !crossed &&
          plan === PLAN_OF[caller] &&
          admitting(input) &&
          next?.schedule?.caller === caller
        ) {
          crossed = true;
          // The real commit, delayed before it starts (its stamp and compare-and-set still pass): nothing has been sent yet.
          await Promise.resolve();
          w.setNow(NOW + delay);
        }
        return run();
      });
      const r = w.make({ service: () => service });
      try {
        r.ensure(TASK, "daily");
        await w.idle(r);
        expect(crossed, "the admission boundary was exercised").toBe(true);
        expect(transmissionsOf(w, caller)).toHaveLength(expected);
        if (expected === 1) return;
        // Refused: withdrawn, then decided again at once: a window pause written, nothing counted for the refusal.
        if (caller === "discovery") {
          expect(w.discovery()?.stop).toEqual({ reason: "unreachable" });
          expect(w.discovery()?.schedule).toMatchObject({
            pause: "window",
            failures: 1,
            issued: null,
          });
        } else {
          expect(w.stored()).toMatchObject({
            phase: "stopped",
            stop: { reason: "unreachable" },
            schedule: { caller, pause: "window", failures: 1, issued: null },
            attempt: caller === "command" ? { key: "frozen-key" } : null,
          });
        }
      } finally {
        r.dispose();
      }
    },
  );

  test.each(CALLERS)(
    "%s: a clock that goes back, or stops being a time, while its admission commits: nothing is transmitted; it pauses (clock)",
    async (caller) => {
      for (const moved of [NOW - 5_000, Number.NaN]) {
        const w = await setup(oneSecondLeft(caller));
        let crossed = false;
        const service = intercepted(w, async (plan, input, run) => {
          const next = input.next as { schedule?: { caller?: string } } | null;
          if (
            !crossed &&
            plan === PLAN_OF[caller] &&
            admitting(input) &&
            next?.schedule?.caller === caller
          ) {
            crossed = true;
            await Promise.resolve();
            w.setNow(moved);
          }
          return run();
        });
        const r = w.make({ service: () => service });
        try {
          r.ensure(TASK, "daily");
          await w.idle(r);
          expect(crossed).toBe(true);
          expect(transmissionsOf(w, caller), String(moved)).toHaveLength(0);
          const s =
            caller === "discovery"
              ? w.discovery()?.schedule
              : w.stored()?.schedule;
          expect(s?.pause, String(moved)).toBe("clock");
        } finally {
          r.dispose();
        }
      }
    },
  );

  test("a binding that ends while the admission commits, or the device going offline: nothing is transmitted", async () => {
    for (const change of ["offline", "binding"] as const) {
      const w = await setup(oneSecondLeft("command"));
      let live = true;
      const real = w.t.env.service() as AccountService;
      const service = intercepted(w, async (plan, input, run) => {
        if (plan === PLAN_OF.command && admitting(input)) {
          const out = await run();
          if (change === "offline") w.setOnline(false);
          else live = false;
          return out;
        }
        return run();
      });
      const r = w.make({ service: () => (live ? service : real) });
      try {
        r.ensure(TASK, "daily");
        await w.settle();
        await w.settle();
        expect(w.sent(), change).toHaveLength(0);
      } finally {
        r.dispose();
      }
    }
  });
});

describe("REVIEW12 R36-1 through the production client: the permission reaches the session's issue", () => {
  /**
   * A session double under the PRODUCTION task client (`createTasksApi`): every request waits at a gate (the session's token, cover and
   * locks) and is issued only if its `admits` still holds then, as the kernel's boundary does (`tests/session/stamped-admits.test.ts`
   * proves the kernel's own). `transmitted`: what crossed the "boundary".
   */
  function heldSession(answer: (method: string, path: string) => Response) {
    const gates: Array<() => void> = [];
    const transmitted: Array<{ method: string; path: string }> = [];
    const asked: Array<{ method: string; path: string }> = [];
    const notSent = { count: 0 };
    const session = {
      api: {
        client: (
          _klass: string,
          _account: string,
          _epoch: number,
          send?: { admits?: () => boolean },
        ) => {
          const issue = async (method: string, path: string) => {
            asked.push({ method, path });
            await new Promise<void>((resolve) => gates.push(resolve));
            if (notSent.count > 0) {
              notSent.count -= 1;
              throw new StampedRequestError("not_sent");
            }
            if (send?.admits?.() === false)
              throw new StampedRequestError("not_sent");
            transmitted.push({ method, path });
            const response = answer(method, path);
            const body = await response
              .clone()
              .json()
              .catch(() => null);
            return response.ok
              ? { data: body, response }
              : { error: body, response };
          };
          return {
            GET: (path: string) => issue("GET", path),
            POST: (path: string) => issue("POST", path),
          };
        },
      },
    } as unknown as Session;
    const open = async (n = 1) => {
      for (let i = 0; i < n; i += 1) {
        for (let k = 0; k < 50 && gates.length === 0; k += 1)
          await new Promise((r) => setTimeout(r, 0));
        gates.shift()?.();
      }
    };
    return { session, transmitted, asked, open, gates, notSent };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  /** The wire body of `GET /tasks/{id}` (the projections without the cache's own `kind_date`). */
  const DETAIL_BODY = (last: string, pending: boolean) => {
    const { task, execution, materialisation } = (
      detail(last, pending) as { value: TaskDetail }
    ).value;
    const wire = (row: TaskDetail["task"] | null) => {
      if (row === null) return null;
      const { kind_date: _, ...rest } = row as typeof row & {
        kind_date?: unknown;
      };
      return rest;
    };
    return { task: wire(task), execution: wire(execution), materialisation };
  };
  const UNAVAILABLE = {
    code: "temporarily_unavailable",
    message: "m",
    request_id: "req-q2",
    details: [],
  };

  test("precondition: the raw detail body parses as the client's answer", () => {
    expect(parseTaskDetail(DETAIL_BODY(TODAY, false))).not.toBeNull();
  });

  test.each([
    ["the command", "command", 1_001, 0],
    ["the command", "command", 500, 1],
    ["the position read", "position", 1_001, 0],
    ["the position read", "position", 500, 1],
  ] as const)(
    "%s (%s) held in the session until +%i ms (its window ends at +1,000): %i issued",
    async (_, caller, delay, expected) => {
      const w = await setup(oneSecondLeft(caller));
      const s = heldSession((method) =>
        method === "POST"
          ? json(503, UNAVAILABLE)
          : json(200, DETAIL_BODY("2026-10-01", true)),
      );
      const r = w.make({ api: createTasksApi(s.session, ACCOUNT, 1) });
      try {
        r.ensure(TASK, "daily");
        // The discovery read goes through; the caller's own request then waits in the session while the clock moves on.
        await s.open(1);
        for (let k = 0; k < 400 && s.asked.length < 2; k += 1) await w.settle();
        expect(s.asked).toHaveLength(2);
        w.setNow(NOW + delay);
        await s.open(1);
        await w.settle();
        await w.settle();
        const own = s.transmitted.slice(1);
        expect(own).toHaveLength(expected);
        if (expected === 0)
          expect(w.stored()?.schedule).toMatchObject({ pause: "window" });
      } finally {
        r.dispose();
        while (s.gates.length > 0) s.gates.shift()?.();
      }
    },
  );

  test("the discovery read held past its window's end issues nothing; held 500 ms, it is issued", async () => {
    for (const [delay, expected] of [
      [1_001, 0],
      [500, 1],
    ] as const) {
      const w = await setup(oneSecondLeft("discovery"));
      const s = heldSession(() => json(200, DETAIL_BODY(TODAY, false)));
      const r = w.make({ api: createTasksApi(s.session, ACCOUNT, 1) });
      try {
        r.ensure(TASK, "daily");
        for (let k = 0; k < 400 && s.asked.length < 1; k += 1) await w.settle();
        w.setNow(NOW + delay);
        await s.open(1);
        await w.idle(r);
        expect(s.transmitted, String(delay)).toHaveLength(expected);
      } finally {
        r.dispose();
        while (s.gates.length > 0) s.gates.shift()?.();
      }
    }
  });

  test("a hidden resend after `not_sent` asks the permission again: none once the window has ended", async () => {
    const w = await setup(oneSecondLeft("position"));
    const s = heldSession(() => json(200, DETAIL_BODY("2026-10-01", true)));
    const r = w.make({ api: createTasksApi(s.session, ACCOUNT, 1) });
    try {
      r.ensure(TASK, "daily");
      await s.open(1);
      for (let k = 0; k < 400 && s.asked.length < 2; k += 1) await w.settle();
      // The session holds the position read back once (`not_sent`); before its resend the window ends.
      s.notSent.count = 1;
      await s.open(1);
      w.setNow(NOW + 1_000);
      for (let k = 0; k < 40; k += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (s.gates.length > 0) await s.open(1);
      }
      expect(s.asked).toHaveLength(2);
      expect(s.transmitted).toHaveLength(1);
    } finally {
      r.dispose();
      while (s.gates.length > 0) s.gates.shift()?.();
    }
  });

  test.each([true, false])(
    "the production readTask asks an initial permission of %s before its first call",
    async (admitted) => {
      const get = vi.fn(async () => ({
        data: {},
        response: new Response("", { status: 200 }),
      }));
      const api = createTasksApi(
        { api: { client: () => ({ GET: get }) } } as never,
        ACCOUNT,
        1,
      );
      await api.readTask(TASK, () => admitted);
      expect(get).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  test.each([true, false])(
    "the production materialise asks an initial permission of %s and carries it to the client",
    async (admitted) => {
      const seen: Array<{ admits?: () => boolean } | undefined> = [];
      const post = vi.fn(async () => ({
        data: {},
        response: new Response("", { status: 200 }),
      }));
      const api = createTasksApi(
        {
          api: {
            client: (
              _k: string,
              _a: string,
              _e: number,
              send?: { admits?: () => boolean },
            ) => {
              seen.push(send);
              return { POST: post };
            },
          },
        } as never,
        ACCOUNT,
        1,
      );
      await api.materialise(
        { kind: "materialise", task_id: TASK, through_date: TODAY, limit: 16 },
        "k",
        () => admitted,
      );
      expect(post).toHaveBeenCalledTimes(admitted ? 1 : 0);
      if (admitted) expect(seen[0]?.admits?.()).toBe(true);
    },
  );

  test("control: a read with no permission is made as before, and its client carries none", async () => {
    const seen: unknown[] = [];
    const get = vi.fn(async () => ({
      data: {},
      response: new Response("", { status: 200 }),
    }));
    const api = createTasksApi(
      {
        api: {
          client: (...args: unknown[]) => {
            seen.push(args[3]);
            return { GET: get };
          },
        },
      } as never,
      ACCOUNT,
      1,
    );
    await api.readTask(TASK);
    await api.readRota(TASK);
    expect(get).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([undefined, undefined]);
  });
});

/** The outcome commit of the caller's issued transmission (not an admission), the first `n` times it is made. */
const failOutcome = (
  w: Awaited<ReturnType<typeof setup>>,
  plan: string,
  expectedPhase: string | null,
  n: number,
) => {
  let failed = 0;
  const service = intercepted(w, async (name, input, run) => {
    const expected = input.expected as { phase?: string } | null;
    if (
      failed < n &&
      name === plan &&
      !admitting(input) &&
      (expectedPhase === null
        ? (input.expected as { attempt?: string | null } | null)?.attempt !=
          null
        : expected?.phase === expectedPhase)
    ) {
      failed += 1;
      return { kind: "failed" };
    }
    return run();
  });
  return { service, failed: () => failed };
};

describe("REVIEW12 R36-2: an answer whose record fails is repaired, or fences its caller across pages and reloads", () => {
  test("CONTROL: a healthy catch-up with markers writes no marker", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    const r = w.make({ markers: m.page("p1") });
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.sent()).toHaveLength(1);
    expect(
      [...m.storage.items.keys()].filter((k) => k.includes("materialise")),
    ).toEqual([]);
    r.dispose();
  });

  test("WITNESS (review 12): ONE failed record of a 429 (Retry-After 60) is repaired: a new runner on the same database sends nothing before its deadline", async () => {
    const w = await setup({
      positions: [
        detail("2026-10-01", true),
        detail("2026-10-01", true),
        detail(TODAY, false),
      ],
      sends: [await http(429, "rate_limited", "60")],
    });
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 1);
    // The repair's own short wait moves the clock; the wait for the deadline is held (this runner then "goes away").
    const r = w.make({
      service: () => f.service,
      sleep: (ms) =>
        ms <= Math.max(...REPAIR_MS)
          ? Promise.resolve(w.setNow(w.now() + ms))
          : new Promise<void>(() => undefined),
    });
    r.ensure(TASK, "daily");
    for (let i = 0; i < 40 && w.stored()?.schedule?.server == null; i += 1)
      await w.settle();
    expect(f.failed()).toBe(1);
    // Repaired: the deadline is durable, and nothing is held in memory.
    expect(w.stored()?.schedule).toMatchObject({
      server: NOW + 60_000,
      issued: null,
    });
    expect(r.get().unrecorded.has(TASK)).toBe(false);
    expect(w.sent()).toHaveLength(1);
    r.dispose();
    const second = w.make();
    try {
      second.ensure(TASK, "daily");
      await w.idle(second);
      expect(w.sent().filter((x) => x.at < NOW + 60_000)).toHaveLength(1);
      expect(new Set(w.sent().map((x) => x.key)).size).toBe(1);
    } finally {
      second.dispose();
    }
  });

  test.each([
    ["a 429's record (Retry-After 60)", "429"],
    ["a successful command's record", "ok"],
  ] as const)(
    "%s never written: a marker fences the day; a new runner, and another page, send nothing automatically",
    async (_, what) => {
      const m = markerWorld();
      const w = await setup({
        positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
        sends: [what === "429" ? await http(429, "rate_limited", "60") : OK],
      });
      const f = failOutcome(
        w,
        "data.writeMaterialiseSequence",
        "submitting",
        99,
      );
      const r = w.make({ service: () => f.service, markers: m.page("p1") });
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(f.failed()).toBe(1 + REPAIR_MS.length);
      expect(r.get().unrecorded.get(TASK)).toMatchObject({
        reason: "storage",
        throughDate: TODAY,
      });
      const scope = {
        account: ACCOUNT,
        incarnationId: (w.t.env.service() as AccountService).incarnationId,
      };
      expect(m.page("p9").probe(scope, fenceOf(TASK, TODAY))).toBe("marked");
      r.dispose();
      // A reload (a new runner, a new markers object over the same storage) and another page: nothing transmitted, the stop shown.
      for (const page of ["p2", "p3"]) {
        const next = w.make({ markers: m.page(page) });
        try {
          next.ensure(TASK, "daily");
          next.kick();
          next.reconnected();
          await w.idle(next);
          expect(w.sent(), page).toHaveLength(1);
          expect(next.get().unrecorded.get(TASK)?.reason).toBe("storage");
        } finally {
          next.dispose();
        }
      }
    },
  );

  test("the person's press on the same page writes the kept 429 first: its deadline holds, then the SAME key once; the marker it saw ends", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      sends: [await http(429, "rate_limited", "60")],
    });
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 3);
    const markers = m.page("p1");
    const r = w.make({ service: () => f.service, markers });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      const stop = r.get().unrecorded.get(TASK);
      expect(stop?.reason).toBe("storage");
      r.tryAgain(TASK, TODAY, { kind: "memory", id: stop?.id as string });
      await w.idle(r);
      const sends = w.sent();
      expect(sends.filter((x) => x.at < NOW + 60_000)).toHaveLength(1);
      expect(sends.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sends.map((x) => x.key)).size).toBe(1);
      const scope = {
        account: ACCOUNT,
        incarnationId: (w.t.env.service() as AccountService).incarnationId,
      };
      expect(markers.probe(scope, fenceOf(TASK, TODAY))).toBe("unmarked");
    } finally {
      r.dispose();
    }
  });

  test("a successful command whose record never lands: the press writes its continuation, so only its position is read (no second command)", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [OK],
    });
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 3);
    const r = w.make({ service: () => f.service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      const stop = r.get().unrecorded.get(TASK);
      expect(stop?.reason).toBe("storage");
      r.tryAgain(TASK, TODAY, { kind: "memory", id: stop?.id as string });
      await w.idle(r);
      // One command in all; after the press a discovery read and then the row's OWN position read (a discovery read is never it).
      expect(w.sent()).toHaveLength(1);
      expect(w.reads()).toHaveLength(3);
      expect(w.stored()).toBeUndefined();
    } finally {
      r.dispose();
    }
  });

  /**
   * Revision 12 (review 13 R36-A, design assessment C3): CORRECTED maintained assertion. Revision 11's case here expected the press after a
   * reload to end the marker and send again after only the lost issue's 1-second pace (its comment called the deadline unknowable). That
   * codified the defect: a marker never says whether the answer was a 429 with a deadline or a success that may only continue with its
   * position read. Its intent (the outcome of a reload with only the marker left) is kept; the expectation is now the approved
   * conservative rule: the stop stays shown, the marker stays, and nothing is transmitted, before the observed deadline and long after it
   * (60 s and 180 s of the fake clock), whatever asks (a press, ensure, a kick, a reconnection).
   */
  test.each([
    ["a 429's record (Retry-After 60)", "429"],
    ["a successful command's record", "ok"],
  ] as const)(
    "after a reload only the marker survives (%s): no press ends it, the stop stays shown and nothing is transmitted, then or later",
    async (_, what) => {
      const m = markerWorld();
      const w = await setup({
        positions: [
          detail("2026-10-01", true),
          detail("2026-10-01", true),
          detail("2026-10-01", true),
          detail("2026-10-01", true),
        ],
        sends: [what === "429" ? await http(429, "rate_limited", "60") : OK],
      });
      const f = failOutcome(
        w,
        "data.writeMaterialiseSequence",
        "submitting",
        99,
      );
      const first = w.make({ service: () => f.service, markers: m.page("p1") });
      first.ensure(TASK, "daily");
      await w.idle(first);
      first.dispose();
      const scope = {
        account: ACCOUNT,
        incarnationId: (w.t.env.service() as AccountService).incarnationId,
      };
      const second = w.make({ markers: m.page("p2") });
      try {
        second.ensure(TASK, "daily");
        await w.idle(second);
        expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
        expect(w.sent()).toHaveLength(1);
        for (const later of [0, 61_000, 181_000]) {
          w.setNow(NOW + later);
          const stop = second.get().unrecorded.get(TASK);
          expect(stop?.reason, `+${later} ms`).toBe("storage");
          second.tryAgain(TASK, TODAY, {
            kind: "memory",
            id: stop?.id as string,
          });
          await w.idle(second);
          second.ensure(TASK, "daily");
          second.kick();
          second.reconnected();
          await w.idle(second);
          expect(w.sent(), `+${later} ms`).toHaveLength(1);
          expect(m.page("p9").probe(scope, fenceOf(TASK, TODAY))).toBe(
            "marked",
          );
          expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
        }
        // The durable row is the issued one still (nothing reduced it as a lost issue, nothing replaced its attempt).
        expect(w.stored()?.phase).toBe("submitting");
        expect(w.stored()?.attempt?.key).toBe(w.sent()[0]?.key);
      } finally {
        second.dispose();
      }
    },
  );

  test("a press ends only the fence instances it saw: one recorded by another page while the press works stays, and still fences the day", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      sends: [await http(429, "rate_limited", "60")],
    });
    let outcomes = 0;
    let newer = false;
    const scope = () => ({
      account: ACCOUNT,
      incarnationId: (w.t.env.service() as AccountService).incarnationId,
    });
    // The 429's record fails three times (the answer, its two repairs); the press's repair is the fourth, and while it commits
    // another page records a newer failure of the same day.
    const service = intercepted(w, async (plan, input, run) => {
      const expected = input.expected as { phase?: string } | null;
      if (
        plan === "data.writeMaterialiseSequence" &&
        !admitting(input) &&
        expected?.phase === "submitting"
      ) {
        outcomes += 1;
        if (outcomes <= 3) return { kind: "failed" };
        if (outcomes === 4) {
          m.page("p2").set(scope(), fenceOf(TASK, TODAY));
          newer = true;
        }
      }
      return run();
    });
    const r = w.make({ service: () => service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      const stop = r.get().unrecorded.get(TASK);
      expect(stop?.reason).toBe("storage");
      r.tryAgain(TASK, TODAY, { kind: "memory", id: stop?.id as string });
      await w.idle(r);
      expect(newer).toBe(true);
      expect(m.page("p3").probe(scope(), fenceOf(TASK, TODAY))).toBe("marked");
      // The newer fence stands: nothing more is sent, and its stop is shown.
      expect(w.sent()).toHaveLength(1);
      expect(r.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      r.dispose();
    }
  });

  test("a fence recorded by another page while a call's admission commits: the call is not issued", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    let crossed = false;
    const service = intercepted(w, async (plan, input, run) => {
      const out = await run();
      if (
        !crossed &&
        plan === "data.writeMaterialiseSequence" &&
        admitting(input)
      ) {
        crossed = true;
        m.page("p2").set(
          {
            account: ACCOUNT,
            incarnationId: (w.t.env.service() as AccountService).incarnationId,
          },
          fenceOf(TASK, TODAY),
        );
      }
      return out;
    });
    const r = w.make({ service: () => service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(crossed).toBe(true);
      expect(w.sent()).toHaveLength(0);
      expect(r.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      r.dispose();
    }
  });

  test("a discovery answer whose record never lands fences the discovery: a new runner reads nothing", async () => {
    const m = markerWorld();
    const w = await setup({ positions: [await TRANSIENT_503()] });
    const f = failOutcome(w, "data.writeMaterialiseDiscovery", null, 99);
    const r = w.make({ service: () => f.service, markers: m.page("p1") });
    r.ensure(TASK, "daily");
    await w.idle(r);
    expect(w.reads()).toHaveLength(1);
    expect(f.failed()).toBe(1 + REPAIR_MS.length);
    r.dispose();
    const next = w.make({ markers: m.page("p2") });
    try {
      next.ensure(TASK, "daily");
      await w.idle(next);
      expect(w.reads()).toHaveLength(1);
      expect(next.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      next.dispose();
    }
  });

  test("a discovery answer recorded at its repair (one failure): nothing fenced, the work goes on", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [await TRANSIENT_503(), detail(TODAY, false)],
    });
    const f = failOutcome(w, "data.writeMaterialiseDiscovery", null, 1);
    const r = w.make({ service: () => f.service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(f.failed()).toBe(1);
      expect(w.reads()).toHaveLength(2);
      expect(r.get().unrecorded.has(TASK)).toBe(false);
    } finally {
      r.dispose();
    }
  });

  test("a marker that cannot be read stands: nothing is transmitted automatically; a marker that cannot be written is held for the page", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    m.storage.failEnumeration = true;
    m.storage.failGets = true;
    const r = w.make({ markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(0);
      expect(r.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      r.dispose();
    }
    const m2 = markerWorld();
    const w2 = await setup({
      positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      sends: [await http(429, "rate_limited", "60")],
    });
    const f = failOutcome(
      w2,
      "data.writeMaterialiseSequence",
      "submitting",
      99,
    );
    m2.storage.failWrites = true;
    const markers = m2.page("p1");
    const first = w2.make({ service: () => f.service, markers });
    first.ensure(TASK, "daily");
    await w2.idle(first);
    first.dispose();
    // The same page's next runner (the same markers object: its memory of stops) is fenced too.
    const again = w2.make({ markers });
    try {
      again.ensure(TASK, "daily");
      await w2.idle(again);
      expect(w2.sent()).toHaveLength(1);
      expect(again.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      again.dispose();
    }
  });

  test("a fence of another database lifetime (incarnation) fences nothing here", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    m.page("p0").set(
      { account: ACCOUNT, incarnationId: "another-lifetime" },
      fenceOf(TASK),
    );
    const r = w.make({ markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.sent()).toHaveLength(1);
    } finally {
      r.dispose();
    }
  });
});

describe("REVIEW12 R36-3: records of earlier builds with an outstanding claim", () => {
  test("CONTROL (review 12): a legacy entry with no claim and no failures makes its first read", async () => {
    const w = await setup({
      discovery: {
        [TASK]: { retry: 0, failures: 0, stop: null, attempt: null },
      },
    });
    const r = w.make();
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(1);
    } finally {
      r.dispose();
    }
  });

  test("WITNESS (review 12): a legacy claim with zero failures stops for the person, its claim and counts kept; nothing read; Try again reads", async () => {
    const w = await setup({
      discovery: {
        [TASK]: {
          retry: 0,
          failures: 0,
          stop: null,
          attempt: "legacy-in-flight",
        },
      },
    });
    const r = w.make();
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(0);
      const entry = w.discovery() as MaterialiseDiscovery;
      expect(entry).toMatchObject({
        retry: 0,
        failures: 0,
        attempt: "legacy-in-flight",
        stop: { reason: "unreachable" },
        schedule: { pause: "legacy" },
      });
      r.tryAgain(TASK, undefined, seenDiscovery(entry));
      await w.idle(r);
      expect(w.reads()).toHaveLength(1);
    } finally {
      r.dispose();
    }
  });

  test("an entry of revision 2 (failures, no claim field, no schedule) is still a legacy stop: nothing read, its count kept", async () => {
    const w = await setup({
      discovery: { [TASK]: { retry: 1, failures: 2, stop: null } },
    });
    const r = w.make();
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.reads()).toHaveLength(0);
      expect(w.discovery()).toMatchObject({
        retry: 1,
        failures: 2,
        stop: { reason: "unreachable" },
        schedule: { pause: "legacy" },
      });
    } finally {
      r.dispose();
    }
  });

  test("a current withdrawn admission (the session held the read) keeps `schedule: null` and is read normally next time, never a legacy stop", async () => {
    const w = await setup({
      positions: [
        { ok: false, kind: "not_sent" },
        detail("2026-10-01", true),
        detail(TODAY, false),
      ],
    });
    const r = w.make();
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.discovery()).toMatchObject({ stop: null, schedule: null });
      expect(w.discovery()?.attempt).not.toBeNull();
      r.kick();
      await w.idle(r);
      expect(w.reads().length).toBeGreaterThanOrEqual(2);
      expect(w.discovery()).toBeUndefined();
    } finally {
      r.dispose();
    }
  });

  test("a legacy row in `ready` holding an attempt is a manual stop keeping that attempt; a legacy `ready` row without one carries on", async () => {
    for (const held of [true, false]) {
      const legacy = row({
        attempt: held
          ? { key: "legacy-key", body: attemptBody(TASK, TODAY) }
          : null,
      });
      delete (legacy as { schedule?: unknown }).schedule;
      const w = await setup({
        seed: [legacy],
        positions: [detail("2026-10-01", true), detail(TODAY, false)],
      });
      const r = w.make();
      try {
        r.ensure(TASK, "daily");
        await w.idle(r);
        if (held) {
          expect(w.sent()).toHaveLength(0);
          expect(w.stored()).toMatchObject({
            phase: "stopped",
            attempt: { key: "legacy-key" },
            schedule: { pause: "legacy" },
          });
        } else expect(w.sent()).toHaveLength(1);
      } finally {
        r.dispose();
      }
    }
  });

  test("a `closed` answer (possibly after a transmission) keeps the admission: the next turn counts it as lost, the same key", async () => {
    const w = await setup({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [{ ok: false, kind: "closed" }, OK],
    });
    const r = w.make();
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(w.stored()?.schedule?.issued).toBe(NOW);
      r.kick();
      await w.idle(r);
      const sends = w.sent();
      expect(sends).toHaveLength(2);
      expect(sends[0]?.key).toBe(sends[1]?.key);
      expect((sends[1]?.at ?? 0) - NOW).toBeGreaterThanOrEqual(1_000);
    } finally {
      r.dispose();
    }
  });
});

describe("REVIEW12 R36-4: a reconnection reaches every paused row of the account", () => {
  const unrelated = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row({
        task_id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
        phase: "stopped",
        stop: { reason: "rejected" },
      }),
    );
  const pausedRow = (task = TASK, over: Partial<MaterialiseRetry> = {}) =>
    row({
      task_id: task,
      phase: "stopped",
      stop: { reason: "unreachable" },
      attempt: {
        key: `frozen-${task.slice(-2)}`,
        body: attemptBody(task, TODAY),
      },
      schedule: schedule({
        caller: "command",
        pause: "window",
        since: NOW - WINDOW_MS,
        failures: 10,
        next: NOW,
        seen: NOW,
        ...over,
      }),
    });

  test.each([0, 99, 100, 101, 199, 201])(
    "%i earlier unrelated retained rows: the paused row after them is resumed once, with its key",
    async (n) => {
      const w = await setup({ seed: [...unrelated(n), pausedRow()] });
      const r = w.make();
      try {
        r.reconnected();
        await w.settle();
        await w.idle(r);
        expect(w.sent()).toHaveLength(1);
        expect(w.sent()[0]?.key).toBe("frozen-b1");
        expect(w.stored()).toBeUndefined();
      } finally {
        r.dispose();
      }
    },
  );

  test("several paused tasks and days beyond the first page: each resumed once; a page exactly full is followed to its end", async () => {
    const tail = [
      "ffffffff-0000-4000-8000-0000000000c1",
      "ffffffff-0000-4000-8000-0000000000c2",
      "ffffffff-0000-4000-8000-0000000000c3",
    ];
    // 197 unrelated + 3 paused = 200 rows: two exactly full pages, then an empty one.
    const w = await setup({
      seed: [...unrelated(197), ...tail.map((t) => pausedRow(t))],
      positions: tail.map((t) => detail(TODAY, false, t)),
    });
    const r = w.make();
    try {
      r.reconnected();
      await w.settle();
      await w.idle(r);
      expect(
        w.log
          .filter((e) => e.what === "send")
          .map((e) => e.task)
          .sort(),
      ).toEqual([...tail].sort());
    } finally {
      r.dispose();
    }
  });

  test("a pause recorded after the reconnection (`seen` later than it) is not lifted by it; one at it is", async () => {
    for (const [seen, expected] of [
      [NOW + 5, 0],
      [NOW, 1],
    ] as const) {
      const w = await setup({
        seed: [...unrelated(120), pausedRow(TASK, { seen })],
      });
      const r = w.make();
      try {
        r.reconnected();
        await w.settle();
        await w.idle(r);
        expect(w.sent(), String(seen)).toHaveLength(expected);
      } finally {
        r.dispose();
      }
    }
  });

  test("a page that cannot be read leaves the scan where it was: the next kick under the same binding carries it on; another binding does not", async () => {
    const w = await setup({ seed: [...unrelated(150), pausedRow()] });
    const real = w.t.env.service() as AccountService;
    let fail = 1;
    const store = new Proxy(real.store, {
      get(target, key, receiver) {
        if (key !== "run") return Reflect.get(target, key, receiver);
        return (plan: { name: string }, input: unknown) => {
          if (
            plan.name === "data.readMaterialiseSequencePage" &&
            (input as { after: unknown }).after !== null &&
            fail > 0
          ) {
            fail -= 1;
            return Promise.reject(new Error("read failed"));
          }
          return target.run(plan as never, input as never);
        };
      },
    });
    const service = new Proxy(real, {
      get(target, key, receiver) {
        return key === "store" ? store : Reflect.get(target, key, receiver);
      },
    }) as AccountService;
    const r = w.make({ service: () => service });
    try {
      r.reconnected();
      await w.settle();
      await w.idle(r);
      expect(w.sent()).toHaveLength(0);
      r.kick();
      await w.settle();
      await w.idle(r);
      expect(w.sent()).toHaveLength(1);
    } finally {
      r.dispose();
    }
    // The same failure, then another binding (the database reopened): the old reconnection's scan is never carried on under it.
    const w2 = await setup({ seed: [...unrelated(150), pausedRow()] });
    const real2 = w2.t.env.service() as AccountService;
    let fail2 = 1;
    const store2 = new Proxy(real2.store, {
      get(target, key, receiver) {
        if (key !== "run") return Reflect.get(target, key, receiver);
        return (plan: { name: string }, input: unknown) => {
          if (
            plan.name === "data.readMaterialiseSequencePage" &&
            (input as { after: unknown }).after !== null &&
            fail2 > 0
          ) {
            fail2 -= 1;
            return Promise.reject(new Error("read failed"));
          }
          return target.run(plan as never, input as never);
        };
      },
    });
    const first = new Proxy(real2, {
      get(target, key, receiver) {
        return key === "store" ? store2 : Reflect.get(target, key, receiver);
      },
    }) as AccountService;
    const second = new Proxy(real2, {}) as AccountService;
    let current = first;
    const r2 = w2.make({ service: () => current });
    try {
      r2.reconnected();
      await w2.settle();
      await w2.idle(r2);
      current = second;
      r2.kick();
      await w2.settle();
      await w2.idle(r2);
      expect(w2.sent()).toHaveLength(0);
    } finally {
      r2.dispose();
    }
  });

  test("an unrecognised pause, a manual stop and a stop of no schedule past the first page are not resumed", async () => {
    const others = [
      pausedRow("eeeeeeee-0000-4000-8000-0000000000d1", {
        pause: "unrecognised",
      }),
      row({
        task_id: "eeeeeeee-0000-4000-8000-0000000000d2",
        phase: "stopped",
        stop: { reason: "bound" },
      }),
    ];
    const w = await setup({ seed: [...unrelated(130), ...others] });
    const r = w.make();
    try {
      r.reconnected();
      await w.settle();
      await w.idle(r);
      expect(w.sent()).toHaveLength(0);
    } finally {
      r.dispose();
    }
  });
});

describe("REVIEW12 R36-2 (production composition): the page's own markers fence the page's runner", () => {
  afterEach(() => {
    forgetCatchUp();
    resetPageDataHost();
  });

  test.each([true, false])(
    "a marker of the task's discovery in the page host (%s): the runner `runnerOf` builds reads nothing; none: it reads",
    async (marked) => {
      const storage = new FakeMarkerStorage();
      resetPageDataHost(
        createPageDataHost(
          createWriteFailureMarkers(storage, undefined, { locks: null }),
        ),
      );
      const w = await setup({ positions: [detail(TODAY, false)] });
      const service = w.t.env.service() as AccountService;
      if (marked)
        createWriteFailureMarkers(storage, undefined, { locks: null }).set(
          { account: ACCOUNT, incarnationId: service.incarnationId },
          fenceOf(TASK),
        );
      const reads: string[] = [];
      const env: TasksEnv = {
        api: {
          readTask: async (id: string) => {
            reads.push(id);
            return detail(TODAY, false, id);
          },
        } as unknown as TasksApi,
        accountId: ACCOUNT,
        identity: `${ACCOUNT}:1`,
        online: true,
        writable: true,
        now: () => NOW,
        newId: () => crypto.randomUUID(),
        dailyPageSize: 200,
      };
      const data = {
        service: () => service,
        serviceStore: { get: () => service, subscribe: () => () => undefined },
        quota: null,
      } as unknown as DataEnv;
      const runner = runnerOf(env, data);
      runner.ensure(TASK, "daily");
      await w.idle(runner);
      expect(reads).toHaveLength(marked ? 0 : 1);
      if (marked)
        expect(runner.get().unrecorded.get(TASK)?.reason).toBe("storage");
    },
  );
});

/**
 * Independent Review 13 (R36-A to R36-D; design assessment Q1): the reviewer's five witnesses and their five paired controls, maintained
 * as they were run (`.agtx/evidence/WEB-10c/review-13/recovery.test.ts`), each assertion and message kept. A recreated runner is another
 * runner over the same database and marker storage: service-level evidence, not a browser reload or a measured 180-second observation.
 */
describe("REVIEW13 Q1: the five witnesses of review 13 and their paired controls", () => {
  const scopeOf = (w: Awaited<ReturnType<typeof setup>>) => ({
    account: ACCOUNT,
    incarnationId: (w.t.env.service() as AccountService).incarnationId,
  });

  for (const recreate of [false, true])
    for (const outcome of ["429", "ok"] as const)
      test(`${recreate ? "WITNESS (R36-A) recreated runner" : "CONTROL same runner"}: manual recovery of ${outcome} preserves the observed result`, async () => {
        const m = markerWorld();
        const w = await setup({
          positions: [
            detail("2026-10-01", true),
            detail("2026-10-01", true),
            detail(TODAY, false),
          ],
          sends: [
            outcome === "429" ? await http(429, "rate_limited", "60") : OK,
          ],
        });
        const f = failOutcome(
          w,
          "data.writeMaterialiseSequence",
          "submitting",
          3,
        );
        const first = w.make({
          service: () => f.service,
          markers: m.page("p1"),
        });
        let runner = first;
        try {
          first.ensure(TASK, "daily");
          await w.idle(first);
          expect(f.failed()).toBe(3);
          expect(w.sent()).toHaveLength(1);
          const initial = w.stored();
          expect(initial?.phase).toBe("submitting");
          expect(initial?.schedule?.issued).not.toBeNull();
          expect(
            m.page("observer").probe(scopeOf(w), fenceOf(TASK, TODAY)),
          ).toBe("marked");
          if (recreate) {
            first.dispose();
            runner = w.make({ markers: m.page("p2") });
            runner.ensure(TASK, "daily");
            await w.idle(runner);
          }
          const stop = runner.get().unrecorded.get(TASK);
          expect(stop?.reason).toBe("storage");
          runner.tryAgain(TASK, TODAY, {
            kind: "memory",
            id: stop?.id as string,
          });
          await w.idle(runner);
          if (outcome === "429")
            expect(
              w.sent().filter((x) => x.at < NOW + 60_000),
              "No manual press may bypass the observed Retry-After deadline",
            ).toHaveLength(1);
          else
            expect(
              w.sent(),
              "A known successful command must continue only with its position GET",
            ).toHaveLength(1);
        } finally {
          first.dispose();
          runner.dispose();
        }
      });

  const pausedRow = (count = 0) =>
    row({
      phase: "stopped",
      stop: { reason: "unreachable" },
      attempt: { key: "frozen-r13", body: attemptBody(TASK, TODAY) },
      successful_calls: count,
      schedule: schedule({
        caller: "command",
        pause: "window",
        since: NOW - WINDOW_MS,
        failures: 10,
        next: NOW,
        seen: NOW,
      }),
    });

  for (const missing of [false, true])
    test(`${missing ? "WITNESS (R36-D)" : "CONTROL"} reconnection while the original live service is ${missing ? "temporarily unbound" : "bound"}`, async () => {
      const w = await setup({ seed: [pausedRow()] });
      const real = w.t.env.service() as AccountService;
      let service: AccountService | null = real;
      const r = w.make({ service: () => service });
      try {
        // Establish this runner's binding before a transient missing-service interval, never switch account/incarnation.
        r.kick();
        w.setOnline(false);
        r.kick();
        if (missing) service = null;
        w.setOnline(true);
        r.reconnected();
        await w.settle();
        service = real;
        r.kick();
        await w.settle();
        await w.idle(r);
        expect(
          w.sent(),
          "The genuine edge must remain actionable for the same original binding",
        ).toHaveLength(1);
      } finally {
        r.dispose();
      }
    });

  for (const reconnect of [false, true])
    test(`${reconnect ? "WITNESS (R36-C)" : "CONTROL"} explicit retry queued behind the account lock ${reconnect ? "then overlapped by a reconnection scan" : "alone"}`, async () => {
      const w = await setup({
        seed: [pausedRow(7)],
        positions: [
          detail("2026-10-01", true),
          detail("2026-10-18", true),
          detail(TODAY, false),
        ],
      });
      let take: (() => Promise<unknown>) | null = null;
      const locks = {
        request: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
          new Promise<void>((resolve, reject) => {
            take = async () => {
              try {
                await fn();
                resolve();
              } catch (e) {
                reject(e);
              }
            };
          }),
      } as unknown as LockManager;
      const r = w.make({ locks });
      try {
        r.tryAgain(
          TASK,
          TODAY,
          seenSequence(w.stored() as MaterialiseSequenceRow, null),
        );
        await w.settle();
        expect(r.get().waiting).toBe(true);
        expect(take).not.toBeNull();
        if (reconnect) {
          w.setOnline(false);
          r.kick();
          w.setOnline(true);
          r.reconnected();
          await w.settle();
        }
        await (take as unknown as () => Promise<unknown>)();
        await w.idle(r);
        expect(
          w.sent(),
          "The explicit retry grants a fresh call budget, even when connectivity also returns",
        ).toHaveLength(2);
        expect(w.stored()).toBeUndefined();
      } finally {
        r.dispose();
      }
    });

  for (const endBeforeRepair of [false, true])
    test(`${endBeforeRepair ? "WITNESS (R36-B)" : "CONTROL"} runner ends ${endBeforeRepair ? "during the first repair delay" : "after the outcome repair"}`, async () => {
      const m = markerWorld();
      const w = await setup({
        positions: [
          detail("2026-10-01", true),
          detail("2026-10-01", true),
          detail(TODAY, false),
        ],
        sends: [await http(429, "rate_limited", "60")],
      });
      const f = failOutcome(
        w,
        "data.writeMaterialiseSequence",
        "submitting",
        1,
      );
      let release: (() => void) | null = null;
      let entered = false;
      const first = w.make({
        service: () => f.service,
        markers: m.page("p1"),
        sleep: (ms) => {
          if (ms === REPAIR_MS[0]) {
            entered = true;
            return new Promise<void>((r) => {
              release = () => {
                w.setNow(w.now() + ms);
                r();
              };
            });
          }
          return new Promise<void>(() => undefined);
        },
      });
      let second: CatchUpRunner | null = null;
      const free = () => (release as (() => void) | null)?.();
      try {
        first.ensure(TASK, "daily");
        for (let k = 0; k < 40 && !entered; k++) await w.settle();
        expect(entered).toBe(true);
        expect(f.failed()).toBe(1);
        expect(w.sent()).toHaveLength(1);
        if (!endBeforeRepair) {
          free();
          await w.settle();
          expect(w.stored()?.schedule?.server).toBe(NOW + 60_000);
        }
        first.dispose();
        if (endBeforeRepair) free();
        await w.settle();
        second = w.make({ markers: m.page("p2") });
        second.ensure(TASK, "daily");
        await w.idle(second);
        expect(
          w.sent().filter((x) => x.at < NOW + 60_000),
          "An observed outcome-write failure cannot be forgotten during its persistence retry wait",
        ).toHaveLength(1);
      } finally {
        first.dispose();
        second?.dispose();
        free();
      }
    });
});

/**
 * Revision 12 (review 13 R36-A to R36-D; design assessment Q2 and Q4 to Q9): the protected outcome's lifecycle (published at its first
 * failure, repaired as the same transition, ended only as its own instance, never ended without its outcome), its withdrawal variant,
 * and the ownership of a press and a reconnection. Production runner, reducers, W27 plans, account service and marker implementation on
 * the IndexedDB and storage doubles; waits are held or move the fake clock. FIXTURE evidence: no browser, no real reload.
 */
describe("REVISION12 R36: protected outcomes and retry ownership", () => {
  const scopeOf = (w: Awaited<ReturnType<typeof setup>>) => ({
    account: ACCOUNT,
    incarnationId: (w.t.env.service() as AccountService).incarnationId,
  });
  const materialiseKeys = (m: ReturnType<typeof markerWorld>) =>
    [...m.storage.items.keys()].filter((k) => k.includes("materialise"));
  /** A runner whose first repair wait is held (entry observable, released by hand); other waits never end. */
  const heldRepair = (w: Awaited<ReturnType<typeof setup>>) => {
    let release: (() => void) | null = null;
    let entered = false;
    return {
      sleep: (ms: number) => {
        if (ms === REPAIR_MS[0] && !entered) {
          entered = true;
          return new Promise<void>((r) => {
            release = () => {
              w.setNow(w.now() + ms);
              r();
            };
          });
        }
        if (ms <= Math.max(...REPAIR_MS))
          return Promise.resolve(w.setNow(w.now() + ms));
        return new Promise<void>(() => undefined);
      },
      entered: () => entered,
      release: () => (release as (() => void) | null)?.(),
    };
  };
  const until = async (
    w: Awaited<ReturnType<typeof setup>>,
    ok: () => boolean,
    what: string,
  ) => {
    for (let k = 0; k < 60 && !ok(); k += 1) await w.settle();
    // An assertion, never a thrown error: a mutant that breaks the precondition is caught by it, not made INVALID.
    expect(ok(), `precondition: ${what}`).toBe(true);
  };

  /** Each caller's world: its answer, the plan and expected phase of its outcome write, and its own transmissions. */
  const CALLER_WORLDS = {
    discovery: {
      options: async () => ({
        positions: [await TRANSIENT_503(), detail(TODAY, false)],
      }),
      plan: "data.writeMaterialiseDiscovery",
      phase: null,
      op: () => fenceOf(TASK),
    },
    command: {
      options: async () => ({
        positions: [
          detail("2026-10-01", true),
          detail("2026-10-01", true),
          detail(TODAY, false),
        ],
        sends: [await http<{ revision: number }>(429, "rate_limited", "60")],
      }),
      plan: "data.writeMaterialiseSequence",
      phase: "submitting",
      op: () => fenceOf(TASK, TODAY),
    },
    position: {
      options: async () => ({
        positions: [
          detail("2026-10-01", true),
          await TRANSIENT_503(),
          detail(TODAY, false),
        ],
        sends: [OK],
      }),
      plan: "data.writeMaterialiseSequence",
      phase: "awaiting_position_read",
      op: () => fenceOf(TASK, TODAY),
    },
  } as const;

  test.each(CALLERS)(
    "Q2 %s: the first failed outcome write is fenced before the first repair wait; a repair that lands ends that fence and the work goes on",
    async (caller) => {
      const c = CALLER_WORLDS[caller];
      const m = markerWorld();
      const w = await setup(await c.options());
      const f = failOutcome(w, c.plan, c.phase, 1);
      const h = heldRepair(w);
      const r = w.make({
        service: () => f.service,
        markers: m.page("p1"),
        sleep: h.sleep,
      });
      try {
        r.ensure(TASK, "daily");
        await until(w, h.entered, "the first repair wait was entered");
        expect(f.failed()).toBe(1);
        // Inside the wait: the fence is durable already, for this caller's operation only.
        expect(m.page("observer").probe(scopeOf(w), c.op())).toBe("marked");
        expect(materialiseKeys(m)).toHaveLength(1);
        h.release();
        await until(
          w,
          () => m.page("observer").probe(scopeOf(w), c.op()) === "unmarked",
          "the repair ended its fence",
        );
        expect(materialiseKeys(m)).toEqual([]);
        expect(r.get().unrecorded.has(TASK)).toBe(false);
      } finally {
        r.dispose();
        h.release();
      }
    },
  );

  /** Q4: every outcome of every caller whose record is never written: fenced at once, and a recreated runner transmits nothing for it. */
  const OUTCOMES: Array<
    [
      caller: CallerName,
      answer: string,
      options: () => Promise<Parameters<typeof setup>[0]>,
    ]
  > = [
    [
      "discovery",
      "success (the entry's removal)",
      async () => ({ positions: [detail(TODAY, false)] }),
    ],
    [
      "discovery",
      "refusal (404)",
      async () => ({ positions: [await http<TaskDetail>(404, "not_found")] }),
    ],
    [
      "discovery",
      "429 (Retry-After 60)",
      async () => ({
        positions: [await http<TaskDetail>(429, "rate_limited", "60")],
      }),
    ],
    ["discovery", "unrecognised", async () => ({ positions: [UNRECOGNISED] })],
    [
      "command",
      "success",
      async () => ({ positions: [detail("2026-10-01", true)], sends: [OK] }),
    ],
    [
      "command",
      "refusal (409)",
      async () => ({
        positions: [detail("2026-10-01", true)],
        sends: [await http(409, "precondition_failed")],
      }),
    ],
    [
      "command",
      "slice capacity",
      async () => ({
        positions: [detail("2026-10-01", true)],
        sends: [await http(503, "slice_capacity")],
      }),
    ],
    [
      "command",
      "429 (Retry-After 60)",
      async () => ({
        positions: [detail("2026-10-01", true)],
        sends: [await http(429, "rate_limited", "60")],
      }),
    ],
    [
      "position",
      "complete (the row's removal)",
      async () => ({
        positions: [detail("2026-10-01", true), detail(TODAY, false)],
        sends: [OK],
      }),
    ],
    [
      "position",
      "continue (still pending)",
      async () => ({
        positions: [detail("2026-10-01", true), detail("2026-10-18", true)],
        sends: [OK],
      }),
    ],
    [
      "position",
      "refusal (404)",
      async () => ({
        positions: [
          detail("2026-10-01", true),
          await http<TaskDetail>(404, "not_found"),
        ],
        sends: [OK],
      }),
    ],
    [
      "position",
      "429 (Retry-After 60)",
      async () => ({
        positions: [
          detail("2026-10-01", true),
          await http<TaskDetail>(429, "rate_limited", "60"),
        ],
        sends: [OK],
      }),
    ],
    [
      "position",
      "unrecognised",
      async () => ({
        positions: [detail("2026-10-01", true), UNRECOGNISED],
        sends: [OK],
      }),
    ],
  ];
  /**
   * RESTORED (revision 15, review 16's R36-I): revision 14 adapted this case to leave a read's success unmarked during the first repair
   * wait (fenced only once its repairs were spent), which let another page transmit for the caller while its record could not be
   * written. That adaptation is withdrawn: every outcome whose first write fails under a live page is marked at that failure, before any
   * repair wait, as revision 12 asserted. A page torn down (a `pagehide` before the failure) is the separate case `REVISION15 Q2`.
   */
  test.each(OUTCOMES)(
    "Q4 %s, %s, never recorded: fenced at the first failure; a recreated runner and another page transmit nothing for it",
    async (caller, _outcome, options) => {
      const c = CALLER_WORLDS[caller];
      const m = markerWorld();
      const w = await setup(await options());
      const f = failOutcome(w, c.plan, c.phase, 99);
      const h = heldRepair(w);
      const first = w.make({
        service: () => f.service,
        markers: m.page("p1"),
        sleep: h.sleep,
      });
      await until(
        w,
        () => {
          first.ensure(TASK, "daily");
          return h.entered();
        },
        "the first repair wait was entered",
      );
      expect(m.page("observer").probe(scopeOf(w), c.op())).toBe("marked");
      h.release();
      await until(
        w,
        // Shown in this page's memory (its reason the answer's, as before: a refusal, or the caller's pace; a recreated page's is `storage`).
        () => first.get().unrecorded.has(TASK),
        "the stop is shown",
      );
      expect(f.failed()).toBe(1 + REPAIR_MS.length);
      expect(m.page("observer").probe(scopeOf(w), c.op())).toBe("marked");
      first.dispose();
      const reads = w.reads().length;
      const sends = w.sent().length;
      for (const page of ["p2", "p3"]) {
        const next = w.make({ markers: m.page(page) });
        try {
          next.ensure(TASK, "daily");
          next.kick();
          next.reconnected();
          await w.idle(next);
          const stop = next.get().unrecorded.get(TASK);
          expect(stop?.reason).toBe("storage");
          next.tryAgain(TASK, caller === "discovery" ? undefined : TODAY, {
            kind: "memory",
            id: stop?.id as string,
          });
          await w.idle(next);
          expect(w.sent(), `${page}: no command`).toHaveLength(sends);
          // A fenced discovery reads nothing; a fenced day costs only the next page's discovery read, never its own caller's.
          expect(w.reads().length - reads, page).toBe(
            caller === "discovery" ? 0 : page === "p2" ? 1 : 2,
          );
          expect(m.page("observer").probe(scopeOf(w), c.op())).toBe("marked");
        } finally {
          next.dispose();
        }
      }
    },
  );

  test("Q5: a repair writes the transition as classified: a clock moved during the wait leaves the 429's deadline where it was", async () => {
    const m = markerWorld();
    const w = await setup(await CALLER_WORLDS.command.options());
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 1);
    const h = heldRepair(w);
    const r = w.make({
      service: () => f.service,
      markers: m.page("p1"),
      sleep: h.sleep,
    });
    try {
      r.ensure(TASK, "daily");
      await until(w, h.entered, "the first repair wait was entered");
      w.setNow(NOW + 30_000);
      h.release();
      await until(
        w,
        () => w.stored()?.schedule?.server != null,
        "the repair landed",
      );
      expect(w.stored()?.schedule?.server).toBe(NOW + 60_000);
      expect(materialiseKeys(m)).toEqual([]);
    } finally {
      r.dispose();
      h.release();
    }
  });

  test("Q5: a repair that finds ANOTHER row stored (a peer's write meanwhile) proves nothing: the fence stays, the stop shows, nothing is sent", async () => {
    const m = markerWorld();
    const w = await setup(await CALLER_WORLDS.command.options());
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 1);
    const h = heldRepair(w);
    const r = w.make({
      service: () => f.service,
      markers: m.page("p1"),
      sleep: h.sleep,
    });
    try {
      r.ensure(TASK, "daily");
      await until(w, h.entered, "the first repair wait was entered");
      const issued = w.stored() as MaterialiseSequenceRow;
      // A peer (no Web Locks) advanced the row: its revision moved; what it holds is not this page's 429.
      w.t.world.idb.seed(DB, "materialise_sequences", [
        { ...issued, revision: (issued.revision ?? 0) + 1, read_seq: 5 },
      ]);
      h.release();
      await until(
        w,
        () => r.get().unrecorded.get(TASK)?.reason === "storage",
        "the stop is shown",
      );
      expect(f.failed()).toBe(1);
      expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK, TODAY))).toBe(
        "marked",
      );
      expect(w.stored()?.read_seq).toBe(5);
      r.ensure(TASK, "daily");
      r.kick();
      await w.settle();
      expect(w.sent()).toHaveLength(1);
    } finally {
      r.dispose();
      h.release();
    }
  });

  test("Q5 control: a first write that applied but answered `failed` is found LANDED by its repair: its fence ends and the deadline holds", async () => {
    const m = markerWorld();
    const w = await setup(await CALLER_WORLDS.command.options());
    let lied = false;
    const service = intercepted(w, async (plan, input, run) => {
      const out = await run();
      const expected = input.expected as { phase?: string } | null;
      if (
        !lied &&
        plan === "data.writeMaterialiseSequence" &&
        !admitting(input) &&
        expected?.phase === "submitting"
      ) {
        lied = true;
        return { kind: "failed" };
      }
      return out;
    });
    const h = heldRepair(w);
    const r = w.make({
      service: () => service,
      markers: m.page("p1"),
      sleep: h.sleep,
    });
    try {
      r.ensure(TASK, "daily");
      await until(w, h.entered, "the first repair wait was entered");
      expect(lied).toBe(true);
      expect(w.stored()?.schedule?.server).toBe(NOW + 60_000);
      expect(materialiseKeys(m)).toHaveLength(1);
      h.release();
      await until(w, () => materialiseKeys(m).length === 0, "the fence ended");
      expect(r.get().unrecorded.has(TASK)).toBe(false);
      expect(w.stored()?.schedule?.server).toBe(NOW + 60_000);
    } finally {
      r.dispose();
      h.release();
    }
  });

  test("Q6: a repair ends only the instance it published: another page's fence recorded before it stays, and still stops the day", async () => {
    const m = markerWorld();
    const w = await setup({
      positions: [detail("2026-10-01", true), detail("2026-10-01", true)],
      sends: [
        async () => {
          // Another page fences the same day while this page's command is answered.
          m.page("peer").set(scopeOf(w), fenceOf(TASK, TODAY));
          return http<{ revision: number }>(429, "rate_limited", "60");
        },
      ],
    });
    const f = failOutcome(w, "data.writeMaterialiseSequence", "submitting", 1);
    const r = w.make({ service: () => f.service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await w.idle(r);
      expect(f.failed()).toBe(1);
      // The repair landed (the deadline is durable) and ended its own instance; the peer's stays.
      expect(w.stored()?.schedule?.server).toBe(NOW + 60_000);
      const keys = materialiseKeys(m);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain("peer");
      w.setNow(NOW + 61_000);
      r.ensure(TASK, "daily");
      r.kick();
      await w.idle(r);
      expect(w.sent()).toHaveLength(1);
      expect(r.get().unrecorded.get(TASK)?.reason).toBe("storage");
    } finally {
      r.dispose();
    }
  });

  test.each(["command", "discovery"] as const)(
    "Q7 %s: a call known not to have been sent whose withdrawal is never written is fenced; a recreated runner counts nothing and sends nothing",
    async (caller) => {
      const m = markerWorld();
      const NOT_SENT = { ok: false, kind: "not_sent" } as const;
      const w = await setup(
        (caller === "command"
          ? { positions: [detail("2026-10-01", true)], sends: [NOT_SENT] }
          : { positions: [NOT_SENT] }) as Parameters<typeof setup>[0],
      );
      const c = CALLER_WORLDS[caller];
      const f = failOutcome(w, c.plan, c.phase, 99);
      const first = w.make({ service: () => f.service, markers: m.page("p1") });
      first.ensure(TASK, "daily");
      await w.idle(first);
      expect(f.failed()).toBe(1 + REPAIR_MS.length);
      expect(first.get().unrecorded.get(TASK)?.reason).toBe("storage");
      expect(m.page("observer").probe(scopeOf(w), c.op())).toBe("marked");
      first.dispose();
      const calls = w.log.length;
      const next = w.make({ markers: m.page("p2") });
      try {
        next.ensure(TASK, "daily");
        next.kick();
        await w.idle(next);
        // Only the recreated runner's discovery read (a fenced day) or nothing at all (a fenced discovery): never the unsent call again.
        expect(w.log.length - calls).toBe(caller === "command" ? 1 : 0);
        expect(w.sent()).toHaveLength(caller === "command" ? 1 : 0);
        // Nothing reduced the unsent call as a lost one.
        const s =
          caller === "command" ? w.stored()?.schedule : w.discovery()?.schedule;
        expect(s?.failures ?? 0).toBe(0);
      } finally {
        next.dispose();
      }
    },
  );

  test.each(["command", "discovery"] as const)(
    "Q7 control %s: a withdrawal written at its repair counts nothing and leaves no fence; the call is made later with its admission",
    async (caller) => {
      const m = markerWorld();
      const NOT_SENT = { ok: false, kind: "not_sent" } as const;
      const w = await setup(
        (caller === "command"
          ? {
              positions: [detail("2026-10-01", true), detail(TODAY, false)],
              sends: [NOT_SENT, OK],
            }
          : { positions: [NOT_SENT, detail(TODAY, false)] }) as Parameters<
          typeof setup
        >[0],
      );
      const c = CALLER_WORLDS[caller];
      const f = failOutcome(w, c.plan, c.phase, 1);
      const r = w.make({ service: () => f.service, markers: m.page("p1") });
      try {
        r.ensure(TASK, "daily");
        await w.idle(r);
        expect(f.failed()).toBe(1);
        expect(materialiseKeys(m)).toEqual([]);
        const s =
          caller === "command" ? w.stored()?.schedule : w.discovery()?.schedule;
        expect(s?.issued ?? null).toBeNull();
        expect(s?.failures ?? 0).toBe(0);
        r.kick();
        await w.idle(r);
        expect(w.stored()).toBeUndefined();
        expect(r.get().unrecorded.has(TASK)).toBe(false);
      } finally {
        r.dispose();
      }
    },
  );

  const windowPaused = (count: number, revision = 1) =>
    row({
      phase: "stopped",
      stop: { reason: "unreachable" },
      attempt: { key: "frozen-r12", body: attemptBody(TASK, TODAY) },
      successful_calls: count,
      revision,
      schedule: schedule({
        caller: "command",
        pause: "window",
        since: NOW - WINDOW_MS,
        failures: 10,
        next: NOW,
        seen: NOW,
      }),
    });
  /** A Web Lock held until `take()`. */
  const heldLock = () => {
    let take: (() => Promise<unknown>) | null = null;
    const locks = {
      request: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
        new Promise<void>((resolve, reject) => {
          take = async () => {
            try {
              await fn();
              resolve();
            } catch (e) {
              reject(e);
            }
          };
        }),
    } as unknown as LockManager;
    return {
      locks,
      queued: () => take !== null,
      take: () => (take as unknown as () => Promise<unknown>)(),
    };
  };
  const SEVEN = () => ({
    seed: [windowPaused(7)],
    positions: [
      detail("2026-10-01", true),
      detail("2026-10-18", true),
      detail(TODAY, false),
    ],
  });

  test("Q8 (other order): a reconnection's lift queued first, then the person's press: the press's fresh budget completes the work", async () => {
    const w = await setup(SEVEN());
    const l = heldLock();
    const r = w.make({ locks: l.locks });
    try {
      w.setOnline(false);
      r.kick();
      w.setOnline(true);
      r.reconnected();
      await w.settle();
      expect(l.queued()).toBe(true);
      r.tryAgain(
        TASK,
        TODAY,
        seenSequence(w.stored() as MaterialiseSequenceRow, null),
      );
      await w.settle();
      await l.take();
      await w.idle(r);
      expect(w.sent()).toHaveLength(2);
      expect(w.stored()).toBeUndefined();
    } finally {
      r.dispose();
    }
  });

  test("Q8 control: a reconnection alone keeps the counted calls: one send, then the existing bound stops it again", async () => {
    const w = await setup(SEVEN());
    const r = w.make();
    try {
      w.setOnline(false);
      r.kick();
      w.setOnline(true);
      r.reconnected();
      await w.settle();
      await w.idle(r);
      expect(w.sent()).toHaveLength(1);
      expect(w.stored()?.phase).toBe("stopped");
    } finally {
      r.dispose();
    }
  });

  test("Q8: a press whose stop no longer stands lifts nothing; the reconnection's own lift behind it resumes the NEWER pause, keeping its calls", async () => {
    const w = await setup(SEVEN());
    const l = heldLock();
    const r = w.make({ locks: l.locks });
    try {
      r.tryAgain(
        TASK,
        TODAY,
        seenSequence(w.stored() as MaterialiseSequenceRow, null),
      );
      await w.settle();
      expect(l.queued()).toBe(true);
      // Another page's budget ended in the same pause again meanwhile: a newer stop (its revision moved), which the press never saw.
      w.t.world.idb.seed(DB, "materialise_sequences", [windowPaused(7, 9)]);
      w.setOnline(false);
      r.kick();
      w.setOnline(true);
      r.reconnected();
      await w.settle();
      await l.take();
      await w.idle(r);
      // The reconnection's resumption (seven calls counted): one send, then the bound; never the press's fresh budget.
      expect(w.sent()).toHaveLength(1);
      expect(w.stored()?.phase).toBe("stopped");
    } finally {
      r.dispose();
    }
  });

  test("Q9: an edge kept for the original service is never taken by another: a replacement, an ended original, or no binding yet", async () => {
    for (const schedule of ["replacement", "ended", "unbound"] as const) {
      const w = await setup({ seed: [windowPaused(0)] });
      const real = w.t.env.service() as AccountService;
      let live = true;
      const original = new Proxy(real, {
        get(target, key, receiver) {
          return key === "live"
            ? live && target.live
            : Reflect.get(target, key, receiver);
        },
      }) as AccountService;
      let service: AccountService | null = original;
      const r = w.make({ service: () => service });
      try {
        if (schedule !== "unbound") r.kick();
        w.setOnline(false);
        service = null;
        if (schedule === "ended") live = false;
        w.setOnline(true);
        r.reconnected();
        await w.settle();
        service =
          schedule === "unbound"
            ? original
            : (new Proxy(real, {}) as AccountService);
        r.kick();
        await w.settle();
        await w.idle(r);
        expect(w.sent(), schedule).toHaveLength(0);
        // A kick is never an edge.
        r.kick();
        await w.idle(r);
        expect(w.sent(), schedule).toHaveLength(0);
      } finally {
        r.dispose();
      }
    }
  });

  test("Q9: the kept edge is consumed once: a second kick after the resumed work sends nothing more", async () => {
    const w = await setup({ seed: [windowPaused(0)] });
    const real = w.t.env.service() as AccountService;
    let service: AccountService | null = real;
    const r = w.make({ service: () => service });
    try {
      r.kick();
      w.setOnline(false);
      service = null;
      w.setOnline(true);
      r.reconnected();
      await w.settle();
      expect(w.sent()).toHaveLength(0);
      service = real;
      r.kick();
      await w.idle(r);
      const after = w.sent().length;
      expect(after).toBeGreaterThanOrEqual(1);
      r.kick();
      r.kick();
      await w.idle(r);
      expect(w.sent()).toHaveLength(after);
    } finally {
      r.dispose();
    }
  });
});

/**
 * Review 14's six witnesses and six paired controls (R36-E: `stale.test.ts`; R36-F: `binding.test.ts`), maintained here with their
 * barriers and assertions as the reviewer wrote them (only the archived observation log is not written). Baseline on 788bfb2: the six
 * witnesses fail, the six controls pass (`.agtx/evidence/WEB-10c/revision-13/q1-baseline-788bfb2.txt`).
 */
describe("REVIEW14 Q1: the six witnesses of review 14 and their paired controls", () => {
  for (const peer of [false, true])
    for (const answer of ["429", "ok"] as const)
      test(`STALE-OUTCOME ${peer ? "WITNESS (R36-E)" : "CONTROL"} ${answer}: observed answer survives a peer admission before its first commit`, async () => {
        const m = markerWorld();
        let releaseFirst!: (x: TasksResult<{ revision: number }>) => void;
        let releasePeer!: (x: TasksResult<{ revision: number }>) => void;
        const first = new Promise<TasksResult<{ revision: number }>>(
          (r) => (releaseFirst = r),
        );
        const second = new Promise<TasksResult<{ revision: number }>>(
          (r) => (releasePeer = r),
        );
        const w = await setup({
          positions: peer
            ? [
                detail("2026-10-01", true),
                detail("2026-10-01", true),
                detail(TODAY, false),
              ]
            : [detail("2026-10-01", true), detail(TODAY, false)],
          sends: peer ? [() => first, () => second, OK] : [() => first, OK],
        });
        const a = w.make({ markers: m.page("origin"), locks: null });
        const b = w.make({ markers: m.page("peer"), locks: null });
        try {
          a.ensure(TASK, "daily");
          for (let i = 0; i < 40 && w.sent().length < 1; i++) await w.settle();
          expect(w.sent()).toHaveLength(1);
          const original = w.stored() as MaterialiseSequenceRow;
          expect(original.phase).toBe("submitting");
          if (peer) {
            b.ensure(TASK, "daily");
            for (let i = 0; i < 80 && w.sent().length < 2; i++)
              await w.settle();
            expect(w.sent()).toHaveLength(2);
            expect(w.stored()?.revision).toBeGreaterThan(
              original.revision as number,
            );
            expect(w.sent()[1]?.key).toBe(w.sent()[0]?.key);
          }
          const before = w.sent().length;
          const observedAt = w.now();
          releaseFirst(
            answer === "429" ? await http(429, "rate_limited", "60") : OK,
          );
          await w.idle(a);
          if (answer === "429")
            expect(
              w
                .sent()
                .slice(before)
                .filter((x) => x.at < observedAt + 60_000),
              "No NEW issue may bypass a 429 already observed by this live owner, even when the first outcome CAS is stale",
            ).toHaveLength(0);
          else
            expect(
              w.sent().slice(before),
              "A known successful command may only continue through its position GET, not a new issue from a stale first outcome CAS",
            ).toHaveLength(0);
        } finally {
          a.dispose();
          b.dispose();
          releaseFirst(OK);
          releasePeer(OK);
          await w.settle();
        }
      });

  for (const caller of [
    "command",
    "discovery",
    "position",
    "command-success",
  ] as const)
    for (const gap of [false, true])
      test(`BINDING-ANSWER ${gap ? "WITNESS (R36-F)" : "CONTROL"} ${caller}: same live service preserves an answer received during a temporary accessor gap`, async () => {
        const m = markerWorld();
        let service: AccountService | null = null;
        let observed = false;
        let observedAt = 0;
        let w: Awaited<ReturnType<typeof setup>>;
        const response = async () => {
          observed = true;
          observedAt = w.now();
          if (gap) service = null;
          return caller === "command-success"
            ? OK
            : await http(429, "rate_limited", "60");
        };
        const command = caller.startsWith("command");
        w = await setup({
          positions:
            caller === "discovery"
              ? [response as never, detail(TODAY, false)]
              : caller === "position"
                ? [
                    detail("2026-10-01", true),
                    response as never,
                    detail(TODAY, false),
                  ]
                : [detail("2026-10-01", true), detail(TODAY, false)],
          sends: command ? [response as never, OK] : [OK],
        });
        const original = w.t.env.service() as AccountService;
        service = original;
        const r = w.make({ service: () => service, markers: m.page("origin") });
        try {
          r.ensure(TASK, "daily");
          await w.idle(r);
          expect(observed).toBe(true);
          expect(original.live).toBe(true);
          if (gap) {
            expect(service).toBeNull();
            service = original;
            r.kick();
            await w.idle(r);
          }
          const calls = command
            ? w.sent()
            : caller === "position"
              ? w.reads().slice(1)
              : w.reads();
          if (caller === "command-success")
            expect(
              calls,
              "Known success must not be downgraded to a lost command when the identical live service returns",
            ).toHaveLength(1);
          else
            expect(
              calls.slice(1).filter((x) => x.at < observedAt + 60_000),
              "A temporary accessor gap must not erase the already-observed Retry-After minimum",
            ).toHaveLength(0);
        } finally {
          r.dispose();
        }
      });
});

/**
 * Revision 13 (review 14's R36-E/F; design assessment Q2 to Q6): an observed outcome is protected from its receipt. Every case asserts its
 * barrier (the held write entered, the peer's admission, the gap) before the step it qualifies, and a healthy control makes progress.
 */
describe("REVISION13 R36-E/F: an observed outcome is protected from its receipt", () => {
  const scopeOf = (w: Awaited<ReturnType<typeof setup>>) => ({
    account: ACCOUNT,
    incarnationId: (w.t.env.service() as AccountService).incarnationId,
  });
  const until = async (
    w: Awaited<ReturnType<typeof setup>>,
    ok: () => boolean,
    what: string,
  ) => {
    for (let k = 0; k < 80 && !ok(); k += 1) await w.settle();
    expect(ok(), `precondition: ${what}`).toBe(true);
  };
  const OP = {
    discovery: () => fenceOf(TASK),
    command: () => fenceOf(TASK, TODAY),
    position: () => fenceOf(TASK, TODAY),
  } as const;
  /** Each caller answered 429 (Retry-After 60) once, then healthy. */
  const WORLD_429 = {
    discovery: async () => ({
      positions: [
        await http<TaskDetail>(429, "rate_limited", "60"),
        detail(TODAY, false),
      ],
    }),
    command: async () => ({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [await http<{ revision: number }>(429, "rate_limited", "60"), OK],
    }),
    position: async () => ({
      positions: [
        detail("2026-10-01", true),
        await http<TaskDetail>(429, "rate_limited", "60"),
        detail(TODAY, false),
      ],
      sends: [OK],
    }),
  } as const;
  /** WORLD_429 with the caller's 429 delivered through `onAnswer` (called with the clock at its receipt, before it is returned). */
  const gapWorld = async (caller: CallerName, onAnswer: () => void) => {
    const world = (await WORLD_429[caller]()) as {
      positions: Array<Answer<TaskDetail>>;
      sends?: Array<Answer<{ revision: number }>>;
    };
    const deliver =
      <T>(answer: Answer<T>) =>
      async () => {
        onAnswer();
        return typeof answer === "function" ? answer() : answer;
      };
    if (caller === "command" && world.sends)
      world.sends[0] = deliver(world.sends[0] as Answer<{ revision: number }>);
    else
      world.positions[caller === "discovery" ? 0 : 1] = deliver(
        world.positions[caller === "discovery" ? 0 : 1] as Answer<TaskDetail>,
      );
    return world;
  };
  /** The server deadline the caller's record holds now. */
  const deadlineOf = (
    w: Awaited<ReturnType<typeof setup>>,
    caller: CallerName,
  ) =>
    caller === "discovery"
      ? (w.discovery()?.schedule?.server ?? null)
      : (w.stored()?.schedule?.server ?? null);
  /** Holds the caller's first OUTCOME write (never an admission) until released: `fail` answers it failed, otherwise the real commit runs. */
  const holdOutcome = (
    w: Awaited<ReturnType<typeof setup>>,
    caller: CallerName,
  ) => {
    let entered = false;
    let release: ((fail: boolean) => void) | null = null;
    const service = intercepted(w, async (name, input, run) => {
      const expected = input.expected as {
        phase?: string;
        attempt?: string | null;
      } | null;
      const outcome =
        name === PLAN_OF[caller] &&
        !admitting(input) &&
        (caller === "discovery"
          ? expected?.attempt != null
          : expected?.phase ===
            (caller === "command" ? "submitting" : "awaiting_position_read"));
      if (!outcome || entered) return run();
      entered = true;
      const fail = await new Promise<boolean>((r) => {
        release = r;
      });
      return fail ? { kind: "failed" } : run();
    });
    return {
      service,
      entered: () => entered,
      release: (fail: boolean) =>
        (release as ((fail: boolean) => void) | null)?.(fail),
    };
  };

  // ---- Q4/Q5: the first write's await --------------------------------------------------------------------------------------------
  for (const caller of CALLERS)
    test(`Q5 ${caller}: the fence stands while the FIRST outcome write is on its way; the write that lands ends it and the work goes on`, async () => {
      const m = markerWorld();
      const w = await setup(await WORLD_429[caller]());
      const h = holdOutcome(w, caller);
      const r = w.make({ service: () => h.service, markers: m.page("p1") });
      try {
        r.ensure(TASK, "daily");
        await until(w, h.entered, "the first outcome write was entered");
        const observedAt = w.now();
        expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
          "marked",
        );
        h.release(false);
        await w.idle(r);
        expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
          "unmarked",
        );
        expect(r.get().unrecorded.has(TASK)).toBe(false);
        const calls = transmissionsOf(w, caller);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[1]?.at).toBeGreaterThanOrEqual(observedAt + 60_000);
      } finally {
        r.dispose();
        h.release(false);
      }
    });

  for (const caller of CALLERS)
    for (const lands of [false, true])
      test(`Q5 ${caller}: a runner disposed while its first outcome write is on its way (${lands ? "the write lands" : "the write fails"}): ${lands ? "control, the record decides" : "its fence survives, and a recreated runner transmits nothing"}`, async () => {
        const m = markerWorld();
        const w = await setup(await WORLD_429[caller]());
        const h = holdOutcome(w, caller);
        const first = w.make({
          service: () => h.service,
          markers: m.page("p1"),
        });
        let second: CatchUpRunner | null = null;
        try {
          first.ensure(TASK, "daily");
          await until(w, h.entered, "the first outcome write was entered");
          const observedAt = w.now();
          const before = transmissionsOf(w, caller).length;
          first.dispose();
          // Before the barrier is released: the fence is durable already.
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            "marked",
          );
          h.release(!lands);
          await w.settle();
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            lands ? "unmarked" : "marked",
          );
          second = w.make({ markers: m.page("p2") });
          second.ensure(TASK, "daily");
          await w.idle(second);
          // The recreated runner's own discovery read (a GET of the discovery caller) is not the position caller's call.
          const all = transmissionsOf(w, caller).slice(before);
          const calls = caller === "position" ? all.slice(1) : all;
          if (lands) {
            expect(deadlineOf(w, caller) ?? observedAt + 60_000).toBe(
              observedAt + 60_000,
            );
            expect(calls.length).toBeGreaterThanOrEqual(1);
            expect(calls[0]?.at).toBeGreaterThanOrEqual(observedAt + 60_000);
          } else {
            expect(calls).toHaveLength(0);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
          }
        } finally {
          second?.dispose();
          h.release(false);
        }
      });

  /** Each caller's call ended by a transport failure (as when the browser cancels it because the page closes), then healthy. */
  const TRANSPORT = {
    ok: false,
    kind: "uncertain",
    retry: { cause: "transport" },
  } as never;
  const WORLD_TRANSPORT = {
    discovery: () => ({ positions: [TRANSPORT, detail(TODAY, false)] }),
    command: () => ({
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
      sends: [TRANSPORT, OK],
    }),
    position: () => ({
      positions: [detail("2026-10-01", true), TRANSPORT, detail(TODAY, false)],
      sends: [OK],
    }),
  } as const;
  /**
   * ADAPTATION (revision 15, labelled; review 16's R36-H, design assessment C1/Q2): this case modelled "the page closes" as a transport
   * failure and a disposal alone. A live page's runner can be disposed with the page still running (another identity), so a transport
   * failure it OBSERVED is now protected from its receipt (the next case). The page closing is modelled as the browsers order it: the
   * page's `pagehide` first, then the call cancelled (Firefox rejects it; the revision 15 native lifecycle probe records the order). Old
   * intent kept: a call cancelled by the page's teardown is not fenced and the recreated runner makes it again (E-M2).
   */
  for (const caller of CALLERS)
    for (const torn of [true, false])
      test(`Q5 ${caller}: a transport failure whose record never lands, ${torn ? "arriving after the page's pagehide (the page closes: the browser cancels the call), is not fenced: the recreated runner counts the call as lost and makes it again" : "observed by a LIVE page whose runner is then disposed, is fenced from its receipt: the recreated runner stops (R36-H)"}`, async () => {
        const m = markerWorld();
        const life = pageLife();
        const world = WORLD_TRANSPORT[caller]() as {
          positions: Array<Answer<TaskDetail>>;
          sends?: Array<Answer<{ revision: number }>>;
        };
        // The caller's transport failure, as the page delivers it: after its `pagehide` when it is torn down.
        const cancelled = async () => {
          if (torn) life.hide();
          return TRANSPORT;
        };
        const w = await setup({
          positions: world.positions.map((a) =>
            a === TRANSPORT ? cancelled : a,
          ),
          ...(world.sends === undefined
            ? {}
            : {
                sends: world.sends.map((a) =>
                  a === TRANSPORT ? cancelled : a,
                ),
              }),
        });
        const h = holdOutcome(w, caller);
        const first = w.make({
          service: () => h.service,
          markers: m.page("p1"),
          lifecycle: life.lifecycle,
        });
        let second: CatchUpRunner | null = null;
        try {
          first.ensure(TASK, "daily");
          await until(w, h.entered, "the first outcome write was entered");
          const before = transmissionsOf(w, caller).length;
          // Torn down: no fence while the write of a call no page that goes on observed is on its way. Live: fenced at its receipt.
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            torn ? "unmarked" : "marked",
          );
          first.dispose();
          h.release(true);
          await w.settle();
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            torn ? "unmarked" : "marked",
          );
          second = w.make({ markers: m.page("p2") });
          second.ensure(TASK, "daily");
          await w.idle(second);
          const all = transmissionsOf(w, caller).slice(before);
          const calls = caller === "position" ? all.slice(1) : all;
          if (torn) {
            expect(
              calls.length,
              "the call is made again (its issue counted as lost), not stopped for good",
            ).toBeGreaterThanOrEqual(1);
            expect(second.get().unrecorded.has(TASK)).toBe(false);
          } else {
            expect(calls, "an observed failure lost: no call").toHaveLength(0);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
          }
        } finally {
          second?.dispose();
          h.release(false);
        }
      });

  // ---- Q4: a gap of the binding (no service displayed, the same service live) -------------------------------------------------------
  for (const caller of CALLERS)
    for (const applied of [false, true])
      test(`Q4 ${caller}: a gap while the first outcome write is on its way (${applied ? "it applies" : "it fails"}); the same service back: the answer recorded as observed, paced by its deadline`, async () => {
        const m = markerWorld();
        const w = await setup(await WORLD_429[caller]());
        const h = holdOutcome(w, caller);
        let service: AccountService | null = h.service;
        const r = w.make({ service: () => service, markers: m.page("p1") });
        try {
          r.ensure(TASK, "daily");
          await until(w, h.entered, "the first outcome write was entered");
          const observedAt = w.now();
          const before = transmissionsOf(w, caller).length;
          service = null;
          h.release(!applied);
          await w.idle(r);
          expect((w.t.env.service() as AccountService).live).toBe(true);
          // Nothing is sent in the gap; the fence stands unless the write landed (exact proof).
          expect(transmissionsOf(w, caller)).toHaveLength(before);
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            applied ? "unmarked" : "marked",
          );
          service = h.service;
          r.kick();
          await w.idle(r);
          expect(r.get().unrecorded.has(TASK)).toBe(false);
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            "unmarked",
          );
          const calls = transmissionsOf(w, caller).slice(before);
          expect(
            calls.length,
            "the work goes on from the recorded answer",
          ).toBeGreaterThanOrEqual(1);
          expect(
            calls[0]?.at,
            "the answer kept through the gap is recorded: nothing before its deadline",
          ).toBeGreaterThanOrEqual(observedAt + 60_000);
        } finally {
          r.dispose();
          h.release(false);
        }
      });

  for (const caller of CALLERS)
    test(`Q4 ${caller}: an answer kept through a gap is written as it was observed (the clock moved 120 s): its deadline is the observed one, not one recomputed at the return`, async () => {
      const m = markerWorld();
      let service: AccountService | null = null;
      let observedAt = -1;
      const w: Awaited<ReturnType<typeof setup>> = await setup(
        await gapWorld(caller, () => {
          observedAt = w.now();
          service = null;
        }),
      );
      const original = w.t.env.service() as AccountService;
      service = original;
      const r = w.make({ service: () => service, markers: m.page("p1") });
      try {
        r.ensure(TASK, "daily");
        await w.idle(r);
        expect(
          observedAt,
          "precondition: the answer arrived in the gap",
        ).toBeGreaterThan(0);
        expect(service).toBeNull();
        const before = transmissionsOf(w, caller).length;
        w.setNow(w.now() + 120_000);
        const returnedAt = w.now();
        service = original;
        r.kick();
        await w.idle(r);
        expect(deadlineOf(w, caller) ?? observedAt + 60_000).not.toBe(
          returnedAt + 60_000,
        );
        const calls = transmissionsOf(w, caller).slice(before);
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(
          calls[0]?.at,
          "the observed deadline (already past) decides, not a deadline recomputed at the return",
        ).toBeLessThan(returnedAt + 60_000);
      } finally {
        r.dispose();
      }
    });

  for (const caller of CALLERS)
    for (const end of ["replaced", "ended", "disposed"] as const)
      test(`Q4 ${caller}: an answer in a gap whose binding is then ${end} writes nothing in another lifetime; its fence stands and nothing is transmitted for it`, async () => {
        const m = markerWorld();
        let service: AccountService | null = null;
        let observedAt = -1;
        const w: Awaited<ReturnType<typeof setup>> = await setup(
          await gapWorld(caller, () => {
            observedAt = w.now();
            service = null;
          }),
        );
        const real = w.t.env.service() as AccountService;
        service = real;
        const r = w.make({ service: () => service, markers: m.page("p1") });
        let reload: CatchUpRunner | null = null;
        try {
          r.ensure(TASK, "daily");
          await w.idle(r);
          expect(
            observedAt,
            "precondition: the answer arrived in the gap",
          ).toBeGreaterThan(0);
          const before = transmissionsOf(w, caller).length;
          const row = w.stored();
          const entry = w.discovery();
          const scope = scopeOf(w);
          expect(m.page("observer").probe(scope, OP[caller]())).toBe("marked");
          if (end === "replaced") {
            // The same account, epoch and incarnation, another service object: a replacement, not the original's return.
            service = new Proxy(real, {}) as AccountService;
            r.kick();
            await w.idle(r);
          } else if (end === "ended") {
            real.dispose("closed");
            service = real;
            r.kick();
            // An ended service is never displayed again: its queued work waits (it is not idle), and nothing is written or sent.
            await w.settle();
          } else {
            r.dispose();
            service = real;
            reload = w.make({ markers: m.page("p2") });
            reload.ensure(TASK, "daily");
            await w.idle(reload);
          }
          // A new runner's own discovery read (a GET of the discovery caller) is not the position caller's call.
          const calls = transmissionsOf(w, caller).slice(before);
          expect(
            caller === "position" && calls.length > 0 && end !== "ended"
              ? calls.slice(1)
              : calls,
          ).toEqual([]);
          if (end !== "ended") {
            expect(w.stored()).toEqual(row);
            expect(w.discovery()).toEqual(entry);
          }
          expect(m.page("observer").probe(scope, OP[caller]())).toBe("marked");
        } finally {
          reload?.dispose();
          r.dispose();
        }
      });

  for (const caller of CALLERS)
    test(`Q4 ${caller}: an answer that arrives after its service ended (no service displayed) publishes nothing and writes nothing`, async () => {
      const m = markerWorld();
      let service: AccountService | null = null;
      let real: AccountService | null = null;
      const w: Awaited<ReturnType<typeof setup>> = await setup(
        await gapWorld(caller, () => {
          (real as AccountService).dispose("closed");
          service = null;
        }),
      );
      real = w.t.env.service() as AccountService;
      const scope = scopeOf(w);
      service = real;
      const r = w.make({ service: () => service, markers: m.page("p1") });
      try {
        r.ensure(TASK, "daily");
        await w.settle();
        await w.settle();
        expect(
          real.ended,
          "precondition: the service ended at the answer",
        ).toBe(true);
        expect(m.page("observer").probe(scope, OP[caller]())).toBe("unmarked");
        expect(
          [...m.storage.items.keys()].filter((k) => k.includes("materialise")),
        ).toEqual([]);
      } finally {
        r.dispose();
      }
    });

  for (const caller of CALLERS)
    test(`Q4 ${caller}: an answer that arrives while ANOTHER service is displayed (the original still live: a replacement) publishes nothing and writes nothing in either`, async () => {
      const m = markerWorld();
      let service: AccountService | null = null;
      let real: AccountService | null = null;
      let replaced = false;
      const w: Awaited<ReturnType<typeof setup>> = await setup(
        await gapWorld(caller, () => {
          // The same account, epoch and incarnation, another service object, displayed as the answer arrives.
          service = new Proxy(real as AccountService, {}) as AccountService;
          replaced = true;
        }),
      );
      real = w.t.env.service() as AccountService;
      service = real;
      const r = w.make({ service: () => service, markers: m.page("p1") });
      try {
        r.ensure(TASK, "daily");
        await until(
          w,
          () => replaced,
          "the answer arrived under a replacement",
        );
        const row = w.stored();
        const entry = w.discovery();
        await w.settle();
        expect(
          real.live && !real.ended,
          "precondition: the original is still live",
        ).toBe(true);
        expect(
          [...m.storage.items.keys()].filter((k) => k.includes("materialise")),
          "nothing of the old binding's answer is published",
        ).toEqual([]);
        if (caller !== "discovery")
          expect(w.stored()?.schedule?.server ?? null).toBe(
            row?.schedule?.server ?? null,
          );
        else
          expect(w.discovery()?.schedule?.server ?? null).toBe(
            entry?.schedule?.server ?? null,
          );
      } finally {
        r.dispose();
      }
    });

  test("Q4 command: a call admitted just before a gap is never sent in it; its withdrawal is written on the return and the call is made then", async () => {
    const m = markerWorld();
    const w = await setup(await WORLD_429.command());
    let held: (() => void) | null = null;
    let entered = false;
    const service = intercepted(w, async (name, input, run) => {
      if (!entered && name === PLAN_OF.command && admitting(input)) {
        entered = true;
        const out = await run();
        await new Promise<void>((r) => {
          held = r;
        });
        return out;
      }
      return run();
    });
    let shown: AccountService | null = service;
    const r = w.make({ service: () => shown, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await until(
        w,
        () => held !== null,
        "the command's first admission was held",
      );
      expect(w.sent()).toEqual([]);
      expect(w.stored()?.schedule?.issued).not.toBeNull();
      shown = null;
      (held as unknown as () => void)();
      await w.idle(r);
      expect(w.sent(), "nothing is sent while no service is displayed").toEqual(
        [],
      );
      shown = service;
      r.kick();
      await w.idle(r);
      expect(w.sent().length).toBeGreaterThanOrEqual(1);
      expect(r.get().unrecorded.has(TASK)).toBe(false);
    } finally {
      r.dispose();
      (held as (() => void) | null)?.();
    }
  });

  // ---- Q2/Q3/Q6: the first write finds another record ----------------------------------------------------------------------------
  /** Two runners without Web Locks: a's call of `caller` held, b's admission of the same caller made and its call held. */
  async function peerAdmitted(caller: CallerName, answer: "429" | "ok") {
    const m = markerWorld();
    const held: Array<(x: TasksResult<unknown>) => void> = [];
    const hold = () =>
      new Promise<TasksResult<never>>((r) => {
        held.push(r as never);
      });
    const w = await setup(
      caller === "discovery"
        ? { positions: [hold, hold, detail(TODAY, false)] }
        : caller === "command"
          ? {
              positions: [
                detail("2026-10-01", true),
                detail("2026-10-01", true),
                detail(TODAY, false),
              ],
              sends: [hold as never, hold as never, OK],
            }
          : {
              positions: [
                detail("2026-10-01", true),
                hold,
                detail("2026-10-01", true),
                hold,
                detail(TODAY, false),
              ],
              sends: [OK],
            },
    );
    const a = w.make({ markers: m.page("a"), locks: null });
    const b = w.make({ markers: m.page("b"), locks: null });
    a.ensure(TASK, "daily");
    await until(w, () => held.length === 1, "a's call is on its way");
    const mine = caller === "discovery" ? w.discovery() : w.stored();
    b.ensure(TASK, "daily");
    await until(w, () => held.length === 2, "b's call is on its way");
    const peer = caller === "discovery" ? w.discovery() : w.stored();
    // b admitted the same caller again over a's admission: a's record of it is gone (another claim, a higher revision).
    if (caller === "discovery")
      expect((peer as MaterialiseDiscovery).attempt).not.toBe(
        (mine as MaterialiseDiscovery).attempt,
      );
    else
      expect((peer as MaterialiseSequenceRow).revision).toBeGreaterThan(
        (mine as MaterialiseSequenceRow).revision as number,
      );
    if (caller === "command") expect(w.sent()[1]?.key).toBe(w.sent()[0]?.key);
    const before = transmissionsOf(w, caller).length;
    const observedAt = w.now();
    const value =
      answer === "429"
        ? await http(429, "rate_limited", "60")
        : caller === "command"
          ? OK
          : caller === "discovery"
            ? detail(TODAY, false)
            : detail(TODAY, false);
    (held[0] as (x: unknown) => void)(value);
    await w.idle(a);
    return { m, w, a, b, held, peer, before, observedAt };
  }

  for (const caller of CALLERS)
    for (const answer of ["429", "ok"] as const)
      test(`Q3 ${caller} ${answer}: the first write of a's answer finds b's admission (stale): a keeps it fenced, transmits nothing more and leaves b's record as it was`, async () => {
        const { m, w, a, b, held, peer, before } = await peerAdmitted(
          caller,
          answer,
        );
        try {
          expect(
            transmissionsOf(w, caller).slice(before),
            "no call is made from the peer's record on behalf of an answer the first write could not record",
          ).toEqual([]);
          expect(caller === "discovery" ? w.discovery() : w.stored()).toEqual(
            peer,
          );
          expect(m.page("observer").probe(scopeOf(w), OP[caller]())).toBe(
            "marked",
          );
          expect(a.get().unrecorded.has(TASK)).toBe(true);
          // a's later work (ensure, kick, its own press) never ends the fence: nothing proves its answer was recorded.
          a.ensure(TASK, "daily");
          a.kick();
          await w.idle(a);
          expect(transmissionsOf(w, caller).slice(before)).toEqual([]);
        } finally {
          a.dispose();
          b.dispose();
          for (const r of held) r(OK as never);
          await w.settle();
        }
      });

  test("Q6 discovery: a success whose entry another page removed already is recorded (landed: the removal it writes); the work goes on, no fence left", async () => {
    const m = markerWorld();
    let releaseA: ((x: TasksResult<TaskDetail>) => void) | null = null;
    const w = await setup({
      positions: [
        () =>
          new Promise<TasksResult<TaskDetail>>((r) => {
            releaseA = r;
          }),
        detail(TODAY, false),
      ],
    });
    const a = w.make({ markers: m.page("a"), locks: null });
    const b = w.make({ markers: m.page("b"), locks: null });
    try {
      a.ensure(TASK, "daily");
      await until(w, () => releaseA !== null, "a's read is on its way");
      // b: a's claim counts as lost, b's own read succeeds and removes the entry (its 1 s pace moves the clock).
      b.ensure(TASK, "daily");
      await w.idle(b);
      expect(w.discovery()).toBeUndefined();
      (releaseA as unknown as (x: TasksResult<TaskDetail>) => void)(
        detail(TODAY, false),
      );
      await w.idle(a);
      expect(a.get().unrecorded.has(TASK)).toBe(false);
      expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK))).toBe(
        "unmarked",
      );
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  test("Q6 discovery: a success whose entry was removed AND admitted again by another page (another claim) is not taken as recorded: fenced", async () => {
    const m = markerWorld();
    let releaseA: ((x: TasksResult<TaskDetail>) => void) | null = null;
    let releaseC: ((x: TasksResult<TaskDetail>) => void) | null = null;
    const w = await setup({
      positions: [
        () =>
          new Promise<TasksResult<TaskDetail>>((r) => {
            releaseA = r;
          }),
        detail(TODAY, false),
        () =>
          new Promise<TasksResult<TaskDetail>>((r) => {
            releaseC = r;
          }),
      ],
    });
    const a = w.make({ markers: m.page("a"), locks: null });
    const b = w.make({ markers: m.page("b"), locks: null });
    const c = w.make({ markers: m.page("c"), locks: null });
    try {
      a.ensure(TASK, "daily");
      await until(w, () => releaseA !== null, "a's read is on its way");
      b.ensure(TASK, "daily");
      await w.idle(b);
      expect(w.discovery()).toBeUndefined();
      c.ensure(TASK, "daily");
      await until(w, () => releaseC !== null, "c's read is on its way");
      const recreated = w.discovery();
      expect(recreated?.attempt).toEqual(expect.any(String));
      (releaseA as unknown as (x: TasksResult<TaskDetail>) => void)(
        detail(TODAY, false),
      );
      await w.idle(a);
      expect(w.discovery()).toEqual(recreated);
      expect(a.get().unrecorded.get(TASK)?.reason).toBe("storage");
      expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK))).toBe(
        "marked",
      );
    } finally {
      a.dispose();
      b.dispose();
      c.dispose();
      (releaseC as ((x: TasksResult<TaskDetail>) => void) | null)?.(
        detail(TODAY, false),
      );
      await w.settle();
    }
  });

  test("Q6 position: a completing read whose row another page removed already is recorded (landed); a recreated row of the day is not", async () => {
    for (const recreate of [false, true]) {
      const m = markerWorld();
      let release: ((x: TasksResult<TaskDetail>) => void) | null = null;
      const w = await setup({
        positions: [
          detail("2026-10-01", true),
          () =>
            new Promise<TasksResult<TaskDetail>>((r) => {
              release = r;
            }),
        ],
        sends: [OK],
      });
      const a = w.make({ markers: m.page("a"), locks: null });
      try {
        a.ensure(TASK, "daily");
        await until(
          w,
          () => release !== null,
          "a's position read is on its way",
        );
        const issued = w.stored() as MaterialiseSequenceRow;
        expect(issued.phase).toBe("awaiting_position_read");
        // Another page's completing read removed the row (and, when recreated, a new generation of the day was begun since).
        w.t.world.idb.clearStore(DB, "materialise_sequences");
        if (recreate)
          w.t.world.idb.seed(DB, "materialise_sequences", [
            row({ sequence_generation: "g-other", revision: 1 }),
          ]);
        const other = w.stored();
        (release as unknown as (x: TasksResult<TaskDetail>) => void)(
          detail(TODAY, false),
        );
        await w.idle(a);
        expect(w.stored()).toEqual(other);
        expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK, TODAY))).toBe(
          recreate ? "marked" : "unmarked",
        );
        expect(a.get().unrecorded.has(TASK)).toBe(recreate);
      } finally {
        a.dispose();
      }
    }
  });

  test("Q6: retiring a's own instance after its outcome lands never retires another page's marker of the operation", async () => {
    const m = markerWorld();
    const w = await setup(await WORLD_429.command());
    const h = holdOutcome(w, "command");
    const r = w.make({ service: () => h.service, markers: m.page("p1") });
    try {
      r.ensure(TASK, "daily");
      await until(w, h.entered, "the first outcome write was entered");
      const peer = m.page("p9").set(scopeOf(w), fenceOf(TASK, TODAY));
      expect(peer.state).toBe("recorded");
      h.release(false);
      await w.idle(r);
      // a's own instance ended; the peer's still marks the day, so the day stays stopped here.
      expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK, TODAY))).toBe(
        "marked",
      );
      const keys = [...m.storage.items.keys()].filter((k) =>
        k.includes("materialise"),
      );
      expect(keys).toHaveLength(1);
    } finally {
      r.dispose();
      h.release(false);
    }
  });
});

/**
 * REVISION 14 (review 15's R36-G; design assessment Q1 to Q5). Every failure the SERVER ANSWERED is fenced from its receipt, before its
 * first write; no answer at all (transport), a withdrawal and a read's success are not (their loss reads as their call lost). Each case
 * first proves the actual runner classified the answer and entered its first outcome write (the barrier), then disposes it while that
 * write waits and releases the write as landed (CONTROL) or failed (WITNESS), and lets a recreated runner over the same database and
 * another marker facade take the work up. FIXTURE evidence (service level: no browser teardown, no real reload).
 */
describe("REVISION14 R36-G: every failure the server answered is protected from its receipt", () => {
  type World = Awaited<ReturnType<typeof setup>>;
  const scopeOf = (w: World) => ({
    account: ACCOUNT,
    incarnationId: (w.t.env.service() as AccountService).incarnationId,
  });
  const until = async (w: World, ok: () => boolean, what: string) => {
    for (let k = 0; k < 80 && !ok(); k += 1) await w.settle();
    expect(ok(), `precondition: ${what}`).toBe(true);
  };
  const OP = (caller: CallerName) =>
    caller === "discovery" ? fenceOf(TASK) : fenceOf(TASK, TODAY);
  const DELAY = 10_000;
  type Script = () => TasksResult<unknown> | Promise<TasksResult<unknown>>;
  /**
   * A scripted API routed by caller (a read while the task's discovery entry holds an issue is the discovery's, any other read the
   * position's): the caller's FIRST call is answered by `first` after the clock moved `delay` (its observation), each later one
   * healthily (`later`, or: the command OK, a discovery read the caught-up task, a position read the caught-up task). Other callers are
   * healthy: a discovery read finds the task behind, a command succeeds, a position read finds it caught up.
   */
  const scripted = (
    w: World,
    caller: CallerName,
    first: Script,
    options: { delay?: number; later?: Script[] } = {},
  ) => {
    const calls: Array<{ caller: CallerName; at: number; key?: string }> = [];
    const later = [...(options.later ?? [])];
    let answered = false;
    let issuedAt = Number.NaN;
    let observedAt = Number.NaN;
    const target = async (): Promise<TasksResult<unknown>> => {
      if (!answered) {
        answered = true;
        issuedAt = w.now();
        w.setNow(w.now() + (options.delay ?? DELAY));
        observedAt = w.now();
        return first();
      }
      const next = later.shift();
      if (next !== undefined) return next();
      return caller === "command" ? OK : detail(TODAY, false);
    };
    const api = {
      readTask: async () => {
        const which: CallerName =
          w.discovery()?.schedule?.issued != null ? "discovery" : "position";
        calls.push({ caller: which, at: w.now() });
        if (which === caller) return target();
        return which === "discovery"
          ? detail("2026-10-01", true)
          : detail(TODAY, false);
      },
      materialise: async (_command: MaterialiseCommand, key: string) => {
        calls.push({ caller: "command", at: w.now(), key });
        return caller === "command" ? target() : OK;
      },
    } as unknown as TasksApi;
    return {
      api,
      calls,
      of: (which: CallerName) => calls.filter((c) => c.caller === which),
      issuedAt: () => issuedAt,
      observedAt: () => observedAt,
    };
  };
  /** Holds the caller's FIRST outcome write (never an admission), keeping what it writes; `fail` answers it failed, else it runs. */
  const holdOutcome = (w: World, caller: CallerName) => {
    let entered = false;
    let written: unknown;
    let release: ((fail: boolean) => void) | null = null;
    const service = intercepted(w, async (name, input, run) => {
      const expected = input.expected as {
        phase?: string;
        attempt?: string | null;
      } | null;
      const outcome =
        name === PLAN_OF[caller] &&
        !admitting(input) &&
        (caller === "discovery"
          ? expected?.attempt != null
          : expected?.phase ===
            (caller === "command" ? "submitting" : "awaiting_position_read"));
      if (!outcome || entered) return run();
      entered = true;
      written = structuredClone(input.next ?? null);
      const fail = await new Promise<boolean>((r) => {
        release = r;
      });
      return fail ? { kind: "failed" } : run();
    });
    return {
      service,
      entered: () => entered,
      written: () => written,
      release: (fail: boolean) =>
        (release as ((fail: boolean) => void) | null)?.(fail),
    };
  };
  /** The production service, every commit's `next` kept (in order) with its plan's name. */
  const recording = (w: World) => {
    const writes: Array<{ name: string; next: unknown }> = [];
    const service = intercepted(w, async (name, input, run) => {
      writes.push({ name, next: structuredClone(input.next ?? null) });
      return run();
    });
    return { service, writes };
  };
  const scheduleOf = (written: unknown) =>
    (written as { schedule?: MaterialiseRetry | null } | null)?.schedule ??
    null;
  /**
   * Up to the barrier, through disposal while it waits, to a recreated runner idle: `received` checks the receipt fence before release.
   * Returns what the second runner did.
   */
  const lose = async (
    caller: CallerName,
    first: Script,
    lands: boolean,
    options: {
      delay?: number;
      later?: Script[];
      /** Fenced from its receipt: the probe before the owner ends shows it. */
      received: boolean;
      /** Revision 15: the page's `pagehide` comes first, and the answer after it (the page is torn down: the browser cancels the call). */
      torn?: boolean;
    },
  ) => {
    const m = markerWorld();
    const w = await setup();
    const life = pageLife();
    const s = scripted(
      w,
      caller,
      options.torn === true
        ? () => {
            life.hide();
            return first();
          }
        : first,
      options,
    );
    const h = holdOutcome(w, caller);
    const one = w.make({
      service: () => h.service,
      markers: m.page("origin"),
      api: s.api,
      lifecycle: life.lifecycle,
    });
    const rec = recording(w);
    let two: CatchUpRunner | null = null;
    try {
      one.ensure(TASK, "daily");
      await until(
        w,
        h.entered,
        "the answer was classified and its first outcome write entered",
      );
      // The receipt fence, seen by another facade BEFORE the owner ends and before its write is released (asserted by `fences`, after
      // each case's protocol assertions, so a runner without it fails at the protocol first).
      const atReceipt = m.page("observer").probe(scopeOf(w), OP(caller));
      const before = s.of(caller).length;
      expect(before, "precondition: one call of the caller made").toBe(1);
      one.dispose();
      h.release(!lands);
      await w.settle();
      const afterRelease = m.page("observer").probe(scopeOf(w), OP(caller));
      two = w.make({
        service: () => rec.service,
        markers: m.page("replacement"),
        api: s.api,
      });
      two.ensure(TASK, "daily");
      await w.idle(two);
      const r = { m, w, s, h, rec, two, before };
      return {
        ...r,
        /** The fence as another facade saw it at the receipt and once the write was released. */
        fences: () => {
          expect(atReceipt, "the receipt fence before the owner ends").toBe(
            options.received ? "marked" : "unmarked",
          );
          expect(afterRelease, "the fence once the first write ended").toBe(
            lands || !options.received ? "unmarked" : "marked",
          );
        },
      };
    } catch (error) {
      two?.dispose();
      throw error;
    } finally {
      one.dispose();
      h.release(false);
    }
  };
  /** A fenced caller stays stopped for every automatic and manual way on (time, kick, reconnection, the person's press). */
  const staysStopped = async (
    r: Awaited<ReturnType<typeof lose>>,
    caller: CallerName,
  ) => {
    const { w, s, two, m } = r;
    expect(s.of(caller), "no further call of the caller").toHaveLength(1);
    const stop = two.get().unrecorded.get(TASK);
    expect(stop?.reason).toBe("storage");
    w.setNow(w.now() + WINDOW_MS + 60_000);
    two.kick();
    await w.idle(two);
    two.reconnected();
    await w.idle(two);
    const shown = two.get().unrecorded.get(TASK);
    two.tryAgain(TASK, caller === "discovery" ? undefined : TODAY, {
      kind: "memory",
      id: shown?.id ?? "",
    });
    await w.idle(two);
    expect(
      s.of(caller),
      "a fence whose outcome no page holds is never cleared by time, a kick, a reconnection or a press",
    ).toHaveLength(1);
    expect(m.page("observer").probe(scopeOf(w), OP(caller))).toBe("marked");
  };

  /** Every failure the server answered, as the production transport classifies it. */
  const RECEIVED: ReadonlyArray<[string, Script, MaterialiseRetry["cause"]]> = [
    ["an unrecognised answer", () => UNRECOGNISED, "unrecognised"],
    ["a 500 internal_error", () => http(500, "internal_error"), "transient"],
    [
      "a 503 temporarily_unavailable",
      () => http(503, "temporarily_unavailable"),
      "transient",
    ],
    [
      "a 429 without Retry-After",
      () => http(429, "rate_limited"),
      "rate_limited",
    ],
    [
      "a 429 with Retry-After 0",
      () => http(429, "rate_limited", "0"),
      "rate_limited",
    ],
    [
      "a 429 with an invalid Retry-After",
      () => http(429, "rate_limited", "soon"),
      "rate_limited",
    ],
  ];

  // ---- Q1: review 15's five witnesses and their controls, maintained ---------------------------------------------------------------
  for (const caller of ["discovery", "position"] as const)
    for (const lands of [true, false])
      test(`REVIEW15 Q1 ${caller} ${lands ? "CONTROL persisted" : "WITNESS lost"}: after three received unrecognised answers no fourth read is admitted`, async () => {
        const m = markerWorld();
        const w = await setup();
        let unknownAnswers = 0;
        const api = {
          readTask: async () => {
            const which =
              w.discovery()?.schedule?.issued != null
                ? "discovery"
                : "position";
            if (which === caller) {
              unknownAnswers += 1;
              return UNRECOGNISED;
            }
            return detail("2026-10-01", true);
          },
          materialise: async () => OK,
        } as unknown as TasksApi;
        let entered = false;
        let release: ((fail: boolean) => void) | undefined;
        let classified: MaterialiseRetry | null = null;
        const service = intercepted(w, async (name, input, run) => {
          const s = scheduleOf(input.next);
          if (
            !entered &&
            name === PLAN_OF[caller] &&
            s?.caller === caller &&
            s.issued === null &&
            s.unknown === 2
          ) {
            entered = true;
            classified = structuredClone(s);
            const fail = await new Promise<boolean>((r) => {
              release = r;
            });
            return fail ? { kind: "failed" } : run();
          }
          return run();
        });
        const first = w.make({
          service: () => service,
          markers: m.page("origin"),
          api,
        });
        let second: CatchUpRunner | undefined;
        try {
          first.ensure(TASK, "daily");
          await until(
            w,
            () => entered,
            "the second received answer reached its first outcome write",
          );
          expect(unknownAnswers).toBe(2);
          expect(classified).toMatchObject({
            caller,
            unknown: 2,
            issued: null,
            pause: null,
          });
          const stateBefore =
            caller === "discovery"
              ? w.discovery()?.schedule
              : w.stored()?.schedule;
          expect(stateBefore).toMatchObject({ caller, unknown: 1 });
          expect(stateBefore?.issued).not.toBeNull();
          // Revision 14: the received answer is fenced before its first write is released (asserted after the protocol's assertions).
          const atReceipt = m.page("observer").probe(scopeOf(w), OP(caller));
          first.dispose();
          release?.(!lands);
          await w.settle();
          second = w.make({ markers: m.page("replacement"), api });
          second.ensure(TASK, "daily");
          await w.idle(second);
          expect(
            unknownAnswers,
            "a received second unknown answer survives teardown or fences the caller; never a fourth read",
          ).toBeLessThanOrEqual(3);
          const after =
            caller === "discovery"
              ? w.discovery()?.schedule
              : w.stored()?.schedule;
          if (lands) {
            expect(unknownAnswers).toBe(3);
            expect(after).toMatchObject({ unknown: 3, pause: "unrecognised" });
          } else {
            expect(unknownAnswers).toBe(2);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
          }
          expect(atReceipt, "the receipt fence before the owner ends").toBe(
            "marked",
          );
        } finally {
          first.dispose();
          second?.dispose();
          release?.(false);
        }
      });

  /**
   * ADAPTATION (revision 14, labelled; design assessment Q1): review 15's pacing probe asserted, in both branches, at least two calls of
   * the caller before comparing the second call's time with observedAt + 1 s. The CONTROL is kept unchanged. The correction takes the
   * review's permitted conservative branch for the WITNESS (the received answer is fenced at receipt and no page holds it), so there is
   * no second call to time: the witness now proves the receipt fence before the owner ends, the replacement's stop, and that no further
   * call of the caller is made through the window, a kick, a reconnection and a press. The original source and its failed results are
   * preserved in review 15's evidence; this does not make that original failure pass.
   */
  for (const caller of CALLERS)
    for (const lands of [true, false])
      test(`REVIEW15 Q1 ${caller} ${lands ? "CONTROL persisted: the next call is no sooner than the observed 503 plus 1 s" : "WITNESS lost: fenced at receipt, the replacement stops and calls nothing"}`, async () => {
        const r = await lose(
          caller,
          () => http(503, "temporarily_unavailable"),
          lands,
          { received: true },
        );
        try {
          expect(scheduleOf(r.h.written())).toMatchObject({
            cause: "transient",
            failures: 1,
            issued: null,
            next: r.s.observedAt() + 1_000,
          });
          if (lands) {
            const calls = r.s.of(caller);
            expect(calls.length).toBeGreaterThanOrEqual(2);
            expect(calls[1]?.at).toBeGreaterThanOrEqual(
              r.s.observedAt() + 1_000,
            );
            if (caller === "command") expect(calls[1]?.key).toBe(calls[0]?.key);
          } else await staysStopped(r, caller);
          r.fences();
        } finally {
          r.two.dispose();
        }
      });

  // ---- Q2: each received failure, each caller -----------------------------------------------------------------------------------
  for (const caller of CALLERS)
    for (const [what, answer, cause] of RECEIVED)
      for (const lands of [true, false])
        test(`Q2 ${caller}, ${what} ${lands ? "persisted (control): paced from its observation" : "whose first write is lost: fenced at receipt, nothing more is called"}`, async () => {
          const r = await lose(caller, answer, lands, { received: true });
          try {
            expect(scheduleOf(r.h.written())).toMatchObject({
              cause,
              failures: 1,
              issued: null,
              unknown: caller !== "command" && cause === "unrecognised" ? 1 : 0,
              next: r.s.observedAt() + 1_000,
            });
            if (lands) {
              const calls = r.s.of(caller);
              expect(calls.length).toBeGreaterThanOrEqual(2);
              expect(calls[1]?.at).toBeGreaterThanOrEqual(
                r.s.observedAt() + 1_000,
              );
              if (caller === "command")
                expect(calls[1]?.key).toBe(calls[0]?.key);
              expect(r.two.get().unrecorded.has(TASK)).toBe(false);
            } else await staysStopped(r, caller);
            r.fences();
          } finally {
            r.two.dispose();
          }
        });

  for (const caller of ["discovery", "position"] as const)
    test(`Q2 ${caller}: the FIRST unrecognised answer of a read is fenced at receipt too (its count is kept or the caller stops)`, async () => {
      const r = await lose(caller, () => UNRECOGNISED, false, {
        delay: 0,
        received: true,
      });
      try {
        expect(scheduleOf(r.h.written())).toMatchObject({ unknown: 1 });
        await staysStopped(r, caller);
        r.fences();
      } finally {
        r.two.dispose();
      }
    });

  // ---- Q5: no answer at all, a withdrawal, a read's success: not fenced at receipt, their loss reads as their call lost --------------
  // Revision 15 (review 16's R36-H): "no answer at all" is now the call the browser cancels as the page is torn down (its `pagehide`
  // first). A transport failure a LIVE page observed is protected from its receipt (REVISION15 Q1 below).
  const TRANSPORT: Script = () =>
    ({ ok: false, kind: "uncertain", retry: { cause: "transport" } }) as never;
  /**
   * ADAPTATION (revision 15, labelled; R36-H, design assessment C1/Q2): revision 14 asserted this for a transport failure delivered to a
   * live page and lost with its runner's disposal, with a RESIDUAL comment for the late one (paced from its issue). That residual is
   * the defect review 16 demonstrated (R36-H). Old intent kept for the case it describes, E-M2's page closing: the answer arrives after
   * the page's `pagehide`, is not fenced, and the next runner counts it lost when issued and makes it again. The live case is a witness.
   */
  for (const caller of CALLERS)
    for (const delay of [0, DELAY])
      test(`Q5 ${caller}: a transport failure (no answer) arriving ${delay === 0 ? "at once" : "10 s after its issue"} AFTER THE PAGE'S PAGEHIDE whose first write is lost is not fenced: the next runner counts it lost when issued and makes the call again (E-M2)`, async () => {
        const r = await lose(caller, TRANSPORT, false, {
          delay,
          received: false,
          torn: true,
        });
        try {
          const calls = r.s.of(caller);
          expect(calls.length, "the call is made again").toBeGreaterThanOrEqual(
            2,
          );
          if (caller === "command") expect(calls[1]?.key).toBe(calls[0]?.key);
          // The lost-response recovery is unchanged: counted as lost WHEN IT WAS ISSUED (failures 1, transport, no unknown count).
          const lost = r.rec.writes.find(
            (e) =>
              e.name === PLAN_OF[caller] &&
              scheduleOf(e.next)?.cause === "transport",
          );
          expect(scheduleOf(lost?.next)).toMatchObject({
            failures: 1,
            cause: "transport",
            unknown: 0,
            since: r.s.issuedAt(),
          });
          expect(calls[1]?.at).toBeGreaterThanOrEqual(r.s.issuedAt() + 1_000);
          expect(r.two.get().unrecorded.has(TASK)).toBe(false);
          r.fences();
        } finally {
          r.two.dispose();
        }
      });

  /**
   * ADAPTATION (revision 15, labelled): the persisted control kept, its receipt expectation changed: a transport failure a live page
   * observed is now marked at its receipt (R36-H) and that instance is retired when its record lands, so the control still proves the
   * work goes on, paced from the observation.
   */
  for (const caller of CALLERS)
    test(`Q5 ${caller}: a transport failure observed by a live page 10 s after its issue and PERSISTED (control) is paced from its observation; its receipt fence retired`, async () => {
      const r = await lose(caller, TRANSPORT, true, { received: true });
      try {
        const calls = r.s.of(caller);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[1]?.at).toBeGreaterThanOrEqual(r.s.observedAt() + 1_000);
        if (caller === "command") expect(calls[1]?.key).toBe(calls[0]?.key);
        expect(r.two.get().unrecorded.has(TASK)).toBe(false);
        r.fences();
      } finally {
        r.two.dispose();
      }
    });

  for (const caller of CALLERS)
    test(`Q5 ${caller}: a withdrawal (not sent) whose first write is lost is not fenced: the next runner counts the call as lost (more conservative than uncounted) and makes it`, async () => {
      const r = await lose(
        caller,
        () => ({ ok: false, kind: "not_sent" }) as never,
        false,
        { delay: 0, received: false },
      );
      try {
        const calls = r.s.of(caller);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        if (caller === "command") expect(calls[1]?.key).toBe(calls[0]?.key);
        const lost = r.rec.writes.find(
          (e) =>
            e.name === PLAN_OF[caller] &&
            scheduleOf(e.next)?.cause === "transport",
        );
        expect(scheduleOf(lost?.next)).toMatchObject({
          failures: 1,
          unknown: 0,
        });
        expect(r.two.get().unrecorded.has(TASK)).toBe(false);
        r.fences();
      } finally {
        r.two.dispose();
      }
    });

  // ---- Q3/Q5: a write that FAILS as the page is torn down (Firefox), against a store that keeps failing under a live page -------------
  /** The caller's first `n` outcome writes (never an admission) answer `failed`, at once. */
  const failing = (w: World, caller: CallerName, n: number) => {
    let failed = 0;
    const service = intercepted(w, async (name, input, run) => {
      const expected = input.expected as {
        phase?: string;
        attempt?: string | null;
      } | null;
      const outcome =
        name === PLAN_OF[caller] &&
        !admitting(input) &&
        (caller === "discovery"
          ? expected?.attempt != null
          : expected?.phase ===
            (caller === "command" ? "submitting" : "awaiting_position_read"));
      if (!outcome || failed >= n) return run();
      failed += 1;
      return { kind: "failed" };
    });
    return { service, failed: () => failed };
  };
  const TEARDOWN: ReadonlyArray<
    [CallerName, string, Script, boolean, Script[]?]
  > = [
    ...CALLERS.flatMap(
      (caller): Array<[CallerName, string, Script, boolean]> => [
        [caller, "no answer (transport)", TRANSPORT, false],
        [
          caller,
          "a withdrawal (not sent)",
          () => ({ ok: false, kind: "not_sent" }) as never,
          false,
        ],
        [
          caller,
          "a received 503",
          () => http(503, "temporarily_unavailable"),
          true,
        ],
      ],
    ),
    [
      "discovery",
      "a success",
      () => detail("2026-10-01", true),
      false,
      [() => detail("2026-10-01", true)],
    ],
    [
      "position",
      "a success (moved, not terminal)",
      () => detail("2026-10-05", true),
      false,
    ],
  ];
  /**
   * ADAPTATION (revision 15, labelled; review 16's R36-I, design assessment C2/Q1/Q2): revision 14 modelled Firefox's teardown as a write
   * that fails while the page is live and the page closing during the first repair wait, and asserted that nothing was published for an
   * outcome not fenced at its receipt. That interval is the one review 16 showed admits a peer (R36-I), so it is split by the order the
   * browser gives: TORN, the page's `pagehide` comes before the answer (the call is cancelled as the page closes, then its write fails):
   * nothing is published and the next runner makes the call again (the old intent: I-10C-M4a on Firefox); LIVE, the write fails while
   * the page is live: the caller is fenced AT THE FAILURE, before the first repair wait, so a peer page (another facade over the same
   * storage, no Web Locks) started during that wait transmits nothing; once the repair lands, its instance is retired and the work goes
   * on (liveness). A received answer is fenced since its receipt in both.
   */
  for (const [caller, what, answer, received, later] of TEARDOWN)
    for (const torn of [true, false])
      test(`Q5 ${caller}, ${what}: its first write FAILS ${torn ? "after the page's pagehide (Firefox: the page torn down)" : "while the page is LIVE, a peer started in the first repair wait"}: ${received || !torn ? "fenced (since its receipt, or at the failure, before any repair wait); no other page calls" : "nothing is published, the next runner makes the call again"}`, async () => {
        const m = markerWorld();
        const w = await setup();
        const life = pageLife();
        const s = scripted(
          w,
          caller,
          torn
            ? () => {
                life.hide();
                return answer();
              }
            : answer,
          { delay: 0, ...(later === undefined ? {} : { later }) },
        );
        const f = failing(w, caller, 1);
        let held = false;
        let resume: (() => void) | null = null;
        const one = w.make({
          service: () => f.service,
          markers: m.page("origin"),
          api: s.api,
          lifecycle: life.lifecycle,
          sleep: (ms) => {
            if (ms === REPAIR_MS[0] && !held) {
              held = true;
              return new Promise<void>((r) => {
                resume = r;
              });
            }
            w.setNow(w.now() + ms);
            return Promise.resolve();
          },
        });
        let two: CatchUpRunner | null = null;
        try {
          one.ensure(TASK, "daily");
          await until(
            w,
            () => held,
            "a failed first write entered its first repair wait",
          );
          expect(f.failed()).toBe(1);
          expect(s.of(caller)).toHaveLength(1);
          const atWait = m.page("observer").probe(scopeOf(w), OP(caller));
          if (torn) {
            one.dispose();
            await w.settle();
          }
          // The replacement (torn) or a peer of the live owner: another facade over the same storage, no Web Locks, its own runner.
          two = w.make({ markers: m.page("replacement"), api: s.api });
          two.ensure(TASK, "daily");
          await w.idle(two);
          if (received || !torn) {
            expect(
              s.of(caller),
              "Decision B: no other page calls for the caller while its failed record is not repaired",
            ).toHaveLength(1);
            expect(two.get().unrecorded.get(TASK)?.reason).toBe("storage");
            expect(atWait, "fenced before the first repair wait").toBe(
              "marked",
            );
          } else {
            expect(
              s.of(caller).length,
              "the call is recovered as lost, never stopped for good",
            ).toBeGreaterThanOrEqual(2);
            expect(two.get().unrecorded.has(TASK)).toBe(false);
            expect(
              atWait,
              "no fence published while the page is torn down",
            ).toBe("unmarked");
          }
          if (!torn) {
            // Liveness: the owner's repair lands; it retires its own instance and the owner's work goes on.
            two.dispose();
            (resume as (() => void) | null)?.();
            await w.idle(one);
            expect(
              m.page("observer").probe(scopeOf(w), OP(caller)),
              "the repaired outcome's instance is retired",
            ).toBe("unmarked");
            expect(one.get().unrecorded.has(TASK)).toBe(false);
          }
        } finally {
          (resume as (() => void) | null)?.();
          one.dispose();
          two?.dispose();
        }
      });

  for (const [caller, what, answer, , later] of TEARDOWN) {
    // ADAPTATION (revision 15, labelled; R36-I): every page is fenced from the FIRST failure (each repair wait sees the marker), not only
    // once the repairs are spent; the rest of the case is unchanged.
    test(`Q3 ${caller}, ${what}: a store that keeps failing under a LIVE page: every page is fenced from the first failure, through every repair wait (Decision B: no automatic transmission after a failed retry-state write)`, async () => {
      const m = markerWorld();
      const w = await setup();
      const s = scripted(w, caller, answer, {
        delay: 0,
        ...(later === undefined ? {} : { later }),
      });
      const f = failing(w, caller, 99);
      const atWaits: string[] = [];
      const one = w.make({
        service: () => f.service,
        markers: m.page("origin"),
        api: s.api,
        sleep: (ms) => {
          if (REPAIR_MS.includes(ms))
            atWaits.push(m.page("observer").probe(scopeOf(w), OP(caller)));
          w.setNow(w.now() + ms);
          return Promise.resolve();
        },
      });
      let two: CatchUpRunner | null = null;
      try {
        one.ensure(TASK, "daily");
        await w.idle(one);
        expect(f.failed()).toBe(1 + REPAIR_MS.length);
        expect(atWaits, "marked in every repair wait").toEqual(
          REPAIR_MS.map(() => "marked"),
        );
        expect(one.get().unrecorded.has(TASK)).toBe(true);
        expect(s.of(caller), "this page made no further call").toHaveLength(1);
        expect(m.page("observer").probe(scopeOf(w), OP(caller))).toBe("marked");
        one.dispose();
        two = w.make({ markers: m.page("replacement"), api: s.api });
        two.ensure(TASK, "daily");
        two.kick();
        two.reconnected();
        await w.idle(two);
        expect(s.of(caller), "no page calls automatically").toHaveLength(1);
        expect(two.get().unrecorded.get(TASK)?.reason).toBe("storage");
      } finally {
        one.dispose();
        two?.dispose();
      }
    });
  }

  // ---- C5 (R38): explicit old-day work after a real change of the task's day ---------------------------------------------------------
  test("C5: after the task's day changed, the explicit day entry (a command's day) recovers the OLD day's retained row with that row's own read: same generation, no command, and no row of the new day", async () => {
    // Issued 30 s before the zone's midnight; recovered 5 s after it (inside the lost call's 180 s window).
    const midnight = dayEnd(TODAY, ZONE) * 1000;
    const issuedAt = midnight - 30_000;
    const w = await setup({
      seed: [
        row({
          phase: "awaiting_position_read",
          read_seq: 1,
          successful_calls: 0,
          schedule: schedule({
            caller: "position",
            issued: issuedAt,
            seen: issuedAt,
          }),
        }),
      ],
      positions: [detail("2026-10-01", true), detail(TODAY, false)],
    });
    // The task's own day is now TODAY + 1 (the device clock passed the zone's midnight).
    w.setNow(midnight + 5_000);
    const rec = recording(w);
    const r = w.make({ service: () => rec.service });
    try {
      expect(todayIn(ZONE, w.now())).toBe(addDays(TODAY, 1));
      r.ensure(TASK, "daily", { throughDate: TODAY });
      await w.idle(r);
      expect(
        w.sent(),
        "no command: the old day's row continues with its read",
      ).toHaveLength(0);
      expect(w.reads()).toHaveLength(2);
      const own = rec.writes.find(
        (e) =>
          e.name === PLAN_OF.position &&
          (e.next as MaterialiseSequenceRow | null)?.through_date === TODAY &&
          scheduleOf(e.next)?.issued != null,
      );
      expect(own?.next).toMatchObject({
        through_date: TODAY,
        sequence_generation: "g-r36",
        phase: "awaiting_position_read",
        read_seq: 1,
        schedule: { caller: "position", failures: 1 },
      });
      expect(
        rec.writes.some(
          (e) =>
            (e.next as MaterialiseSequenceRow | null)?.through_date ===
            addDays(TODAY, 1),
        ),
        "no row of the new day",
      ).toBe(false);
      expect(
        w.stored(),
        "the old day is covered by its own read",
      ).toBeUndefined();
    } finally {
      r.dispose();
    }
  });

  test("Q5 discovery: a success whose first write is lost is not fenced; the next runner reads again and sends nothing before its own discovery and position reads", async () => {
    const r = await lose("discovery", () => detail("2026-10-01", true), false, {
      delay: 0,
      later: [() => detail("2026-10-01", true)],
      received: false,
    });
    try {
      const discoveries = r.s.of("discovery");
      expect(discoveries).toHaveLength(2);
      const sends = r.s.of("command");
      expect(
        sends,
        "the first runner sent nothing on the lost success",
      ).toHaveLength(1);
      const order = r.s.calls.map((c) => c.caller);
      expect(order.indexOf("command")).toBeGreaterThan(
        order.lastIndexOf("discovery"),
      );
      expect(r.two.get().unrecorded.has(TASK)).toBe(false);
      r.fences();
    } finally {
      r.two.dispose();
    }
  });

  test("Q5 position: a success (the position moved, not terminal) whose first write is lost is not fenced; the next runner reads again, GET only, and counts the call once", async () => {
    const r = await lose("position", () => detail("2026-10-05", true), false, {
      delay: 0,
      later: [() => detail("2026-10-09", true)],
      received: false,
    });
    try {
      expect(scheduleOf(r.h.written())).toBeNull();
      expect((r.h.written() as MaterialiseSequenceRow).successful_calls).toBe(
        1,
      );
      const order = r.s.calls.map((c) => c.caller);
      const firstSend = order.indexOf("command");
      const replacementRead = order.indexOf(
        "position",
        order.indexOf("position") + 1,
      );
      expect(replacementRead).toBeGreaterThan(firstSend);
      expect(
        order.slice(firstSend + 1, replacementRead),
        "no command between the success and the replacement's own position read",
      ).not.toContain("command");
      const ready = r.rec.writes.find(
        (e) =>
          e.name === PLAN_OF.position &&
          (e.next as MaterialiseSequenceRow | null)?.phase === "ready",
      );
      expect(
        (ready?.next as MaterialiseSequenceRow | undefined)?.successful_calls,
        "the call is counted once, by the read that is recorded",
      ).toBe(1);
      r.fences();
    } finally {
      r.two.dispose();
    }
  });
});

/**
 * Revision 15 (review 16's R36-H, R36-I and R39; design assessment C1–C3, Q1–Q3): review 16's eighteen transport-boundary schedules,
 * maintained with their assertions tightened (no permissive branch), the lifecycle orderings of the design assessment's matrix, and the
 * received-invalid body through the production client for each caller. FIXTURE evidence: the production runner, W27 plans, account service
 * and marker facades over the IndexedDB double and fake marker storage; scripted time; no browser, no real teardown (the page's lifecycle
 * is the double `pageLife`; the native order is recorded by the revision 15 lifecycle probe).
 */
describe("REVISION15 R36-H/I: a failure observed by a live page is kept from its receipt; a failed write fences at once", () => {
  type World = Awaited<ReturnType<typeof setup>>;
  const scopeOf = (w: World) => ({
    account: ACCOUNT,
    incarnationId: (w.t.env.service() as AccountService).incarnationId,
  });
  const OP = (caller: CallerName) =>
    caller === "discovery" ? fenceOf(TASK) : fenceOf(TASK, TODAY);
  const TRANSPORT_FAILURE = () =>
    call<never>(
      async () => {
        throw new TypeError("simulated connection loss");
      },
      () => null,
    );

  /**
   * The caller's FIRST call answered `failure` 10 s after its issue (its observation), later ones healthily; the caller's first outcome
   * write held (`lost-pending`: released failed after the owner's disposal), answered failed at once (`failed-live`: the owner kept live in
   * its held first repair wait), or run (`persisted`). `hideBefore`: the page's `pagehide` just before the answer is delivered.
   */
  const schedule16 = async (
    caller: CallerName,
    failure: TasksResult<never>,
    mode: "persisted" | "lost-pending" | "failed-live",
    life: Life = pageLife(),
    hideBefore = false,
    /**
     * Revision 16 (review 17's R36-J; design assessment Q2): the page's events around the failure: as it is delivered (`atReceipt`), and
     * as its first outcome write is entered (`atFirstWrite`: in the task the failure was delivered in).
     */
    hooks: {
      atReceipt?: (l: Life) => void;
      atFirstWrite?: (l: Life) => void;
    } = {},
  ) => {
    const m = markerWorld();
    const w = await setup();
    let received = 0;
    let observedAt = 0;
    const calls: Array<{ caller: CallerName; at: number; key?: string }> = [];
    const answer = async () => {
      if (++received === 1) {
        w.setNow(w.now() + 10_000);
        observedAt = w.now();
        if (hideBefore) life.hide();
        hooks.atReceipt?.(life);
        return failure;
      }
      return caller === "command" ? OK : detail(TODAY, false);
    };
    const api = {
      readTask: async () => {
        const which: CallerName =
          w.discovery()?.schedule?.issued != null ? "discovery" : "position";
        calls.push({ caller: which, at: w.now() });
        if (which === caller) return answer();
        return which === "discovery"
          ? detail("2026-10-01", true)
          : detail(TODAY, false);
      },
      materialise: async (_c: MaterialiseCommand, key: string) => {
        calls.push({ caller: "command", at: w.now(), key });
        return caller === "command" ? answer() : OK;
      },
    } as unknown as TasksApi;
    let entered = false;
    let inRepair = false;
    let release: ((fail: boolean) => void) | undefined;
    let resume: (() => void) | undefined;
    let classified: MaterialiseRetry | null = null;
    const service = intercepted(w, async (name, input, run) => {
      const s = (input.next as { schedule?: MaterialiseRetry } | null)
        ?.schedule;
      if (
        !entered &&
        name === PLAN_OF[caller] &&
        s?.caller === caller &&
        s.issued === null &&
        s.cause ===
          ((failure as { retry?: { cause?: string } }).retry?.cause ??
            "unrecognised")
      ) {
        entered = true;
        classified = structuredClone(s);
        hooks.atFirstWrite?.(life);
        if (mode === "failed-live") return { kind: "failed" };
        if (mode === "persisted") return run();
        const fail = await new Promise<boolean>((r) => {
          release = r;
        });
        return fail ? { kind: "failed" } : run();
      }
      return run();
    });
    const owner = w.make({
      service: () => service,
      markers: m.page("origin"),
      api,
      lifecycle: life.lifecycle,
      sleep: async (ms) => {
        if (mode === "failed-live" && ms === REPAIR_MS[0] && !inRepair) {
          inRepair = true;
          await new Promise<void>((r) => {
            resume = r;
          });
        } else w.setNow(w.now() + ms);
      },
    });
    return {
      m,
      w,
      calls,
      owner,
      life,
      of: (which: CallerName) => calls.filter((c) => c.caller === which),
      observedAt: () => observedAt,
      classified: () => classified,
      entered: () => entered,
      inRepair: () => inRepair,
      release: (fail: boolean) => release?.(fail),
      resume: () => resume?.(),
      probe: () => m.page("observer").probe(scopeOf(w), OP(caller)),
      peer: (id: string) => w.make({ markers: m.page(id), api }),
    };
  };
  const until = async (w: World, ok: () => boolean, what: string) => {
    for (let k = 0; k < 80 && !ok(); k += 1) await w.settle();
    expect(ok(), `precondition: ${what}`).toBe(true);
  };

  // ---- Q1: review 16's eighteen schedules (6 witnesses: transport lost-pending and failed-live, each caller) -------------------------
  for (const caller of CALLERS)
    for (const mode of ["persisted", "lost-pending", "failed-live"] as const)
      for (const cause of ["transport", "transient"] as const)
        test(`REVIEW16 Q1 ${caller} ${cause} ${mode}: ${mode === "persisted" ? "CONTROL: the next call no sooner than the observation + 1 s" : mode === "lost-pending" ? "the write lost across disposal: fenced at receipt, the replacement calls nothing" : "the write failed under the live owner: a peer in the first repair wait calls nothing"}`, async () => {
          const failure =
            cause === "transient"
              ? await http<never>(503, "temporarily_unavailable")
              : await TRANSPORT_FAILURE();
          expect(failure).toMatchObject({
            ok: false,
            kind: "uncertain",
            retry: { cause },
          });
          const r = await schedule16(caller, failure, mode);
          let second: CatchUpRunner | undefined;
          try {
            r.owner.ensure(TASK, "daily");
            await until(
              r.w,
              mode === "failed-live" ? r.inRepair : r.entered,
              mode === "failed-live"
                ? "the first write failed and the owner waits in its first repair"
                : "the failure was classified and its first outcome write reached",
            );
            expect(r.classified()).toMatchObject({
              cause,
              issued: null,
              failures: 1,
              next: r.observedAt() + 1_000,
            });
            const atBoundary = r.probe();
            if (mode === "lost-pending") {
              r.owner.dispose();
              r.release(true);
              await r.w.settle();
            }
            second = r.peer("replacement");
            second.ensure(TASK, "daily");
            await r.w.idle(second);
            const selected = r.of(caller);
            if (mode === "persisted") {
              expect(selected.length).toBeGreaterThanOrEqual(2);
              expect(selected[1]?.at).toBeGreaterThanOrEqual(
                r.observedAt() + 1_000,
              );
              if (caller === "command")
                expect(selected[1]?.key).toBe(selected[0]?.key);
              expect(r.probe(), "the receipt fence is retired").toBe(
                "unmarked",
              );
            } else {
              expect(
                selected,
                "Decision B: no automatic transmission of the caller after its retry state could not be recorded",
              ).toHaveLength(1);
              expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
              expect(
                atBoundary,
                "fenced before the write was lost (at receipt) or before the first repair wait",
              ).toBe("marked");
            }
          } finally {
            r.owner.dispose();
            second?.dispose();
            r.release(false);
            r.resume();
          }
        });

  // ---- Q2: lifecycle orderings (design assessment matrix) ----------------------------------------------------------------------------
  for (const caller of CALLERS) {
    test(`Q2 ${caller}: a transport failure observed while live THEN the page's pagehide (its write lost): still fenced, the replacement calls nothing`, async () => {
      const r = await schedule16(
        caller,
        await TRANSPORT_FAILURE(),
        "lost-pending",
      );
      let second: CatchUpRunner | undefined;
      try {
        r.owner.ensure(TASK, "daily");
        await until(r.w, r.entered, "the first outcome write reached");
        r.life.hide();
        r.owner.dispose();
        r.release(true);
        await r.w.settle();
        expect(r.probe()).toBe("marked");
        second = r.peer("replacement");
        second.ensure(TASK, "daily");
        await r.w.idle(second);
        expect(r.of(caller)).toHaveLength(1);
        expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
      } finally {
        r.owner.dispose();
        second?.dispose();
        r.release(false);
      }
    });

    test(`Q2 ${caller}: the page's pagehide THEN a transport failure 10 s after the issue (the call cancelled), its write failing: nothing published; the replacement recovers the call as lost from its issue`, async () => {
      const life = pageLife();
      const r = await schedule16(
        caller,
        await TRANSPORT_FAILURE(),
        "failed-live",
        life,
        true,
      );
      let second: CatchUpRunner | undefined;
      try {
        r.owner.ensure(TASK, "daily");
        await until(r.w, r.inRepair, "the first write failed");
        expect(r.probe(), "a torn-down page publishes no fence").toBe(
          "unmarked",
        );
        r.owner.dispose();
        second = r.peer("replacement");
        second.ensure(TASK, "daily");
        await r.w.idle(second);
        expect(r.of(caller).length).toBeGreaterThanOrEqual(2);
        if (caller === "command")
          expect(r.of(caller)[1]?.key).toBe(r.of(caller)[0]?.key);
        expect(second.get().unrecorded.has(TASK)).toBe(false);
      } finally {
        r.owner.dispose();
        second?.dispose();
        r.resume();
      }
    });

    for (const [what, received] of [
      ["a received 503", () => http<never>(503, "temporarily_unavailable")],
      [
        "an unrecognised answer without retry facts",
        async () => UNRECOGNISED as TasksResult<never>,
      ],
    ] as const)
      test(`Q2 ${caller}: ${what} after the page's pagehide is still fenced from its receipt (a received answer is never a teardown)`, async () => {
        const r = await schedule16(
          caller,
          await received(),
          "lost-pending",
          pageLife(),
          true,
        );
        let second: CatchUpRunner | undefined;
        try {
          r.owner.ensure(TASK, "daily");
          await until(r.w, r.entered, "the first outcome write reached");
          expect(r.probe()).toBe("marked");
          r.owner.dispose();
          r.release(true);
          await r.w.settle();
          second = r.peer("replacement");
          second.ensure(TASK, "daily");
          await r.w.idle(second);
          expect(r.of(caller)).toHaveLength(1);
        } finally {
          r.owner.dispose();
          second?.dispose();
          r.release(false);
        }
      });

    test(`Q2 ${caller}: a back-forward restore (pagehide, a cancelled call whose write fails, then pageshow) publishes the held fence at once: a peer then calls nothing`, async () => {
      const life = pageLife();
      const r = await schedule16(
        caller,
        await TRANSPORT_FAILURE(),
        "failed-live",
        life,
        true,
      );
      let second: CatchUpRunner | undefined;
      try {
        r.owner.ensure(TASK, "daily");
        await until(r.w, r.inRepair, "the first write failed");
        expect(r.probe()).toBe("unmarked");
        life.show();
        expect(r.probe(), "published when the page is shown again").toBe(
          "marked",
        );
        second = r.peer("peer");
        second.ensure(TASK, "daily");
        await r.w.idle(second);
        expect(r.of(caller)).toHaveLength(1);
        expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
      } finally {
        r.owner.dispose();
        second?.dispose();
        r.resume();
      }
    });
  }

  for (const caller of CALLERS)
    test(`Q2 ${caller}: a teardown that began BEFORE the call was issued (a navigation abandoned after its beforeunload) does not cover it: its transport failure, observed live, is fenced from its receipt`, async () => {
      // Revision 16 (R36-J): that navigation's event is its `beforeunload` (`leave`); revision 15 drove it with its single `teardown`.
      const life = pageLife();
      life.leave();
      const r = await schedule16(
        caller,
        await TRANSPORT_FAILURE(),
        "lost-pending",
        life,
      );
      let second: CatchUpRunner | undefined;
      try {
        r.owner.ensure(TASK, "daily");
        await until(r.w, r.entered, "the first outcome write reached");
        expect(r.probe(), "fenced at its receipt").toBe("marked");
        r.owner.dispose();
        r.release(true);
        await r.w.settle();
        second = r.peer("replacement");
        second.ensure(TASK, "daily");
        await r.w.idle(second);
        expect(r.of(caller)).toHaveLength(1);
        expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
      } finally {
        r.owner.dispose();
        second?.dispose();
        r.release(false);
      }
    });

  test("Q2: a disposed runner publishes nothing on a later pageshow (its lifetime ended)", async () => {
    const life = pageLife();
    const r = await schedule16(
      "discovery",
      await TRANSPORT_FAILURE(),
      "failed-live",
      life,
      true,
    );
    try {
      r.owner.ensure(TASK, "daily");
      await until(r.w, r.inRepair, "the first write failed");
      r.owner.dispose();
      life.show();
      expect(r.probe()).toBe("unmarked");
    } finally {
      r.resume();
    }
  });

  for (const torn of [true, false])
    test(`Q2 discovery: a transport failure arriving in a GAP of its binding (no service displayed) ${torn ? "after the page's pagehide: kept for its binding, no fence published; the next runner makes the call again" : "while the page is live: kept for its binding and fenced (R36-F); the next runner calls nothing"}`, async () => {
      const m = markerWorld();
      const life = pageLife();
      let shown: AccountService | null = null;
      const w = await setup();
      shown = w.t.env.service() as AccountService;
      let reads = 0;
      const api = {
        readTask: async () => {
          reads += 1;
          if (reads > 1) return detail(TODAY, false);
          if (torn) life.hide();
          shown = null;
          return TRANSPORT_FAILURE();
        },
        materialise: async () => OK,
      } as unknown as TasksApi;
      const one = w.make({
        service: () => shown,
        markers: m.page("origin"),
        api,
        lifecycle: life.lifecycle,
      });
      let two: CatchUpRunner | undefined;
      try {
        one.ensure(TASK, "daily");
        for (let k = 0; k < 80 && reads === 0; k += 1) await w.settle();
        await w.settle();
        expect(reads, "precondition: the discovery read was made").toBe(1);
        expect(
          m.page("observer").probe(scopeOf(w), fenceOf(TASK)),
          torn ? "no fence from a torn-down page" : "fenced in its gap",
        ).toBe(torn ? "unmarked" : "marked");
        one.dispose();
        two = w.make({ markers: m.page("replacement"), api });
        two.ensure(TASK, "daily");
        await w.idle(two);
        expect(reads).toBe(torn ? 2 : 1);
      } finally {
        one.dispose();
        two?.dispose();
      }
    });

  // ---- Revision 16 (review 17's R36-J; design assessment Q1/Q2/Q3/Q5): an ATTEMPTED departure is not a departure -------------------
  /**
   * A `beforeunload` while the call is on its way, and no `pagehide` after it: a navigation answered with 204, a download, one the person
   * cancelled (review 17's native evidence: the page goes on). Maintained from review 17's 54-case probe (its source is kept unchanged in
   * the review's evidence and replayed separately): the failure the page observed is kept, so its first write lost or failed stops the
   * caller for every page (Decision B), and a persisted one is paced from its observation (control).
   */
  for (const caller of CALLERS)
    for (const mode of ["persisted", "lost-pending", "failed-live"] as const)
      test(`R36-J ${caller} ${mode}: a beforeunload while the call is on its way and no pagehide (an abandoned navigation): ${mode === "persisted" ? "CONTROL: paced from the observation, its fence retired" : mode === "lost-pending" ? "the failure the page observed is fenced; its write lost with the runner, the replacement calls nothing" : "its write failed under the live owner: fenced, a peer in the first repair wait calls nothing"}`, async () => {
        const r = await schedule16(
          caller,
          await TRANSPORT_FAILURE(),
          mode,
          pageLife(),
          false,
          { atReceipt: (l) => l.leave() },
        );
        let second: CatchUpRunner | undefined;
        try {
          r.owner.ensure(TASK, "daily");
          await until(
            r.w,
            mode === "failed-live" ? r.inRepair : r.entered,
            mode === "failed-live"
              ? "the first write failed and the owner waits in its first repair"
              : "the failure was classified and its first outcome write reached",
          );
          expect(r.classified()).toMatchObject({
            cause: "transport",
            issued: null,
            failures: 1,
            next: r.observedAt() + 1_000,
          });
          if (mode === "failed-live")
            expect(r.probe(), "fenced before the first repair wait").toBe(
              "marked",
            );
          if (mode === "lost-pending") {
            r.owner.dispose();
            expect(r.probe(), "fenced once the owner ended").toBe("marked");
            r.release(true);
            await r.w.settle();
          }
          second = r.peer("replacement");
          second.ensure(TASK, "daily");
          await r.w.idle(second);
          const selected = r.of(caller);
          if (mode === "persisted") {
            expect(selected.length).toBeGreaterThanOrEqual(2);
            expect(selected[1]?.at).toBeGreaterThanOrEqual(
              r.observedAt() + 1_000,
            );
            if (caller === "command")
              expect(selected[1]?.key).toBe(selected[0]?.key);
            expect(r.probe(), "the receipt fence is retired").toBe("unmarked");
          } else {
            expect(
              selected,
              "Decision B: no automatic transmission after the observed failure's retry state could not be recorded",
            ).toHaveLength(1);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
            expect(r.probe()).toBe("marked");
          }
        } finally {
          r.owner.dispose();
          second?.dispose();
          r.release(false);
          r.resume();
        }
      });

  /**
   * The orders of the page's events around one failure (its write lost with the runner): `in-dispatch` a `beforeunload`, then the
   * failure delivered DURING the page's `pagehide` dispatch, before the lifecycle's own listener runs (Chromium's order, natively
   * revision 16's diagnostic: `window.event` is that `pagehide`): the call was cancelled by the departure, nothing is published, the next
   * page recovers it as lost from its issue (E-M2). `left-in-write` (Kieran's D1 decision): a `beforeunload`, the failure, then the page's
   * `pagehide` in that same task while its first write is on its way: observed before the departure began, so fenced. `after-a-task`:
   * a `beforeunload`, the failure, a task the page runs, then its `pagehide` (as Firefox and WebKit deliver a navigation's cancellation):
   * fenced, and the later `pagehide` withdraws nothing. `twice`: one navigation abandoned before the call, another while it is on its
   * way: fenced. `observed-first`: the failure observed with no departure attempted, then a `beforeunload` and a `pagehide` while its
   * write is on its way: fenced at receipt; a later event revokes nothing.
   */
  for (const caller of CALLERS)
    for (const order of [
      "in-dispatch",
      "left-in-write",
      "after-a-task",
      "twice",
      "observed-first",
    ] as const)
      test(`R36-J ${caller} order ${order}: ${order === "in-dispatch" ? "delivered during the page's pagehide dispatch: cancelled by the departure, nothing published, the replacement makes the call again from its issue (E-M2)" : "observed before the page's departure began: fenced, its write lost, the replacement calls nothing"}`, async () => {
        const life = pageLife();
        if (order === "twice") life.leave();
        const r = await schedule16(
          caller,
          await TRANSPORT_FAILURE(),
          "lost-pending",
          life,
          false,
          {
            atReceipt: (l) => {
              if (order !== "observed-first") l.leave();
              if (order === "in-dispatch") l.dispatch(true);
            },
            atFirstWrite: (l) => {
              // The dispatch goes on: the lifecycle's own listener runs (in-dispatch); or the page leaves as its write is on its way.
              if (order === "in-dispatch" || order === "left-in-write")
                l.hide();
              if (order === "in-dispatch") l.dispatch(false);
            },
          },
        );
        let second: CatchUpRunner | undefined;
        try {
          r.owner.ensure(TASK, "daily");
          await until(r.w, r.entered, "the first outcome write reached");
          if (order === "observed-first")
            expect(r.probe(), "fenced at its receipt").toBe("marked");
          // The page's next task (its departure judged when it was attempted and not confirmed).
          await r.w.settle();
          if (order === "after-a-task" || order === "observed-first") {
            if (order === "observed-first") life.leave();
            life.hide();
          }
          r.owner.dispose();
          r.release(true);
          await r.w.settle();
          second = r.peer("replacement");
          second.ensure(TASK, "daily");
          await r.w.idle(second);
          const selected = r.of(caller);
          if (order === "in-dispatch") {
            expect(r.probe(), "nothing published").toBe("unmarked");
            expect(
              selected.length,
              "the call is made again",
            ).toBeGreaterThanOrEqual(2);
            if (caller === "command")
              expect(selected[1]?.key).toBe(selected[0]?.key);
            expect(second.get().unrecorded.has(TASK)).toBe(false);
          } else {
            expect(r.probe(), "fenced").toBe("marked");
            expect(selected).toHaveLength(1);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
          }
        } finally {
          r.owner.dispose();
          second?.dispose();
          r.release(false);
        }
      });

  /**
   * A back-forward restore (`pagehide` then `pageshow`) while the first write of a failure the departure left unpublished is still on its
   * way: the page goes on, so its fence is published at the restore (not only for a failed write); its write then fails (the peer calls
   * nothing) or lands (control: the fence retired, the work goes on).
   */
  for (const caller of CALLERS)
    for (const lands of [false, true])
      test(`R36-J ${caller}: a failure cancelled by the page's departure, its first write on its way, then a back-forward restore: fenced at the restore; ${lands ? "CONTROL: the write lands, the fence retired and the work goes on" : "the write fails, a peer calls nothing"}`, async () => {
        const r = await schedule16(
          caller,
          await TRANSPORT_FAILURE(),
          "lost-pending",
          pageLife(),
          false,
          { atReceipt: (l) => l.hide() },
        );
        let second: CatchUpRunner | undefined;
        try {
          r.owner.ensure(TASK, "daily");
          await until(r.w, r.entered, "the first outcome write reached");
          expect(r.probe(), "nothing published by the departed page").toBe(
            "unmarked",
          );
          r.life.show();
          expect(r.probe(), "published at the restore").toBe("marked");
          // Lost: the owner ends while its first write is on its way, and that write fails.
          if (!lands) r.owner.dispose();
          r.release(!lands);
          await r.w.settle();
          if (!lands) {
            second = r.peer("peer");
            second.ensure(TASK, "daily");
            await r.w.idle(second);
            expect(r.of(caller)).toHaveLength(1);
            expect(second.get().unrecorded.get(TASK)?.reason).toBe("storage");
            expect(r.probe()).toBe("marked");
          } else {
            expect(r.probe(), "retired by its own record").toBe("unmarked");
            await r.w.idle(r.owner);
            const selected = r.of(caller);
            expect(selected.length).toBeGreaterThanOrEqual(2);
            expect(
              selected[1]?.at,
              "paced from the observation",
            ).toBeGreaterThanOrEqual(r.observedAt() + 1_000);
            if (caller === "command")
              expect(selected[1]?.key).toBe(selected[0]?.key);
          }
        } finally {
          r.owner.dispose();
          second?.dispose();
          r.release(false);
        }
      });

  /**
   * Not kept at receipt (a read's success, a withdrawal), its first write FAILS after a `beforeunload`: judged by the page's next task.
   * `pagehide` in that task (the departure): nothing published, the next runner reads again; none (an abandoned navigation): fenced.
   */
  for (const departs of [true, false])
    test(`R36-J discovery: a success whose first write fails after a beforeunload, ${departs ? "the pagehide in the same task: nothing published, the next runner reads again" : "no pagehide (an abandoned navigation): fenced, the next runner reads nothing"}`, async () => {
      const m = markerWorld();
      const life = pageLife();
      const w = await setup();
      let reads = 0;
      const api = {
        readTask: async () => {
          reads += 1;
          if (reads === 1) life.leave();
          return detail(TODAY, false);
        },
        materialise: async () => OK,
      } as unknown as TasksApi;
      let failed = 0;
      const service = intercepted(w, async (name, input, run) => {
        if (name === PLAN_OF.discovery && input.next === null && failed === 0) {
          failed += 1;
          if (departs) life.hide();
          return { kind: "failed" };
        }
        return run();
      });
      const one = w.make({
        service: () => service,
        markers: m.page("origin"),
        api,
        lifecycle: life.lifecycle,
        sleep: () => new Promise<void>(() => undefined),
      });
      let two: CatchUpRunner | undefined;
      try {
        one.ensure(TASK, "daily");
        for (let k = 0; k < 80 && failed === 0; k += 1) await w.settle();
        await w.settle();
        expect(failed, "precondition: the success's first write failed").toBe(
          1,
        );
        expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK))).toBe(
          departs ? "unmarked" : "marked",
        );
        one.dispose();
        two = w.make({ markers: m.page("replacement"), api });
        two.ensure(TASK, "daily");
        await w.idle(two);
        expect(reads).toBe(departs ? 2 : 1);
      } finally {
        one.dispose();
        two?.dispose();
      }
    });

  /** A gap of its binding (no service displayed) after a `beforeunload` and no `pagehide`: kept for its binding and fenced. */
  test("R36-J discovery: a transport failure in a GAP of its binding after a beforeunload and no pagehide (an abandoned navigation): kept for its binding and fenced; the next runner calls nothing", async () => {
    const m = markerWorld();
    const life = pageLife();
    let shown: AccountService | null = null;
    const w = await setup();
    shown = w.t.env.service() as AccountService;
    let reads = 0;
    const api = {
      readTask: async () => {
        reads += 1;
        if (reads > 1) return detail(TODAY, false);
        life.leave();
        shown = null;
        return TRANSPORT_FAILURE();
      },
      materialise: async () => OK,
    } as unknown as TasksApi;
    const one = w.make({
      service: () => shown,
      markers: m.page("origin"),
      api,
      lifecycle: life.lifecycle,
    });
    let two: CatchUpRunner | undefined;
    try {
      one.ensure(TASK, "daily");
      for (let k = 0; k < 80 && reads === 0; k += 1) await w.settle();
      await w.settle();
      expect(reads, "precondition: the discovery read was made").toBe(1);
      expect(m.page("observer").probe(scopeOf(w), fenceOf(TASK))).toBe(
        "marked",
      );
      one.dispose();
      two = w.make({ markers: m.page("replacement"), api });
      two.ensure(TASK, "daily");
      await w.idle(two);
      expect(reads).toBe(1);
    } finally {
      one.dispose();
      two?.dispose();
    }
  });

  // ---- Q3: a received body that is not JSON, through the production client, for each caller ------------------------------------------
  const client = (body: string, count: { n: number }) =>
    createTasksApi(
      {
        api: {
          client: () =>
            createApiClient(async () => {
              count.n += 1;
              return new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }, "http://127.0.0.1/api/experimental/v1"),
        },
      } as unknown as Session,
      ACCOUNT,
      1,
    );
  for (const body of ["{}", "{"] as const) {
    const label =
      body === "{}"
        ? "CONTROL valid JSON of the wrong shape"
        : "WITNESS malformed JSON";
    test(`REVIEW16 R39 discovery, ${label}: three received unrecognised answers pause the caller`, async () => {
      const w = await setup();
      const count = { n: 0 };
      const r = w.make({ api: client(body, count) });
      try {
        r.ensure(TASK, "daily");
        await w.idle(r);
        expect(count.n, "three unrecognised read answers").toBe(3);
        expect(w.discovery()?.schedule).toMatchObject({
          unknown: 3,
          pause: "unrecognised",
        });
      } finally {
        r.dispose();
      }
    });
    for (const caller of ["position", "command"] as const)
      test(`REVIEW16 R39 ${caller}, ${label}: ${caller === "position" ? "three received unrecognised answers pause the caller" : "fenced from its receipt, before its first outcome write"}`, async () => {
        const w = await setup();
        const count = { n: 0 };
        const actual = client(body, count);
        const api = {
          readTask: (id: string, permit?: () => boolean) =>
            w.discovery()?.schedule?.issued != null
              ? Promise.resolve(detail("2026-10-01", true))
              : caller === "position"
                ? actual.readTask(id, permit)
                : Promise.resolve(detail(TODAY, false)),
          materialise:
            caller === "command" ? actual.materialise : async () => OK,
        } as unknown as TasksApi;
        const m = markerWorld();
        let reached = false;
        let release: ((fail: boolean) => void) | undefined;
        const service = intercepted(w, async (name, input, run) => {
          const s = (input.next as { schedule?: MaterialiseRetry } | null)
            ?.schedule;
          if (
            caller === "command" &&
            !reached &&
            name === PLAN_OF.command &&
            s?.caller === "command" &&
            s.issued === null &&
            s.failures === 1
          ) {
            reached = true;
            expect(s.cause).toBe("unrecognised");
            const fail = await new Promise<boolean>((res) => {
              release = res;
            });
            return fail ? { kind: "failed" } : run();
          }
          return run();
        });
        const r = w.make({
          api,
          markers: m.page("origin"),
          service: () => service,
        });
        try {
          r.ensure(TASK, "daily");
          if (caller === "position") {
            await w.idle(r);
            expect(count.n).toBe(3);
            expect(w.stored()?.schedule).toMatchObject({
              unknown: 3,
              pause: "unrecognised",
            });
          } else {
            for (let i = 0; i < 80 && !reached; i += 1) await w.settle();
            expect(reached).toBe(true);
            expect(
              m
                .page("observer")
                .probe(
                  { account: ACCOUNT, incarnationId: service.incarnationId },
                  fenceOf(TASK, TODAY),
                ),
            ).toBe("marked");
          }
        } finally {
          r.dispose();
          release?.(true);
          await w.settle();
        }
      });
  }
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  followIdentity,
  type IdentityTask,
  type TaskOutcome,
} from "../../src/data/engine/identity-task";
import type { Identity } from "../../src/session";
import {
  identityReadWorld,
  watchTransactions,
} from "../support/data/identity-reads";
import { ACCOUNT, pageWorld } from "../support/data/page-world";

/**
 * R16 (revision 8): `followIdentity`, the runner of the profile read and the device mirror, inside the data layer's per-caller retry
 * budget (plan 5.6, classes 2 and 3). FIXTURE evidence: the task is scripted, the database is the production plans over the double
 * of IndexedDB, and time is the world's.
 *
 * The delays below are exact because the jitter is pinned (`random: 0.5`): the back-off is 2 s doubling to 60 s, and a failure that
 * has lasted `retrySustainedMs` (180 s) pauses the caller: the eighth failure, at 182 s.
 */
type World = Awaited<ReturnType<typeof pageWorld>>;

const settle = async (w: World) => {
  for (let i = 0; i < 12; i += 1) await w.env.settle();
};
const advance = async (w: World, ms: number) => {
  await w.env.world.advance(ms);
  await settle(w);
};

async function setup(
  options: {
    database?: boolean;
    /** With `database: false`: still being looked for (the default), or genuinely absent. */
    binding?: "pending" | "absent";
    caller?: string;
    epoch?: number;
  } = {},
) {
  const w = await pageWorld({ epoch: options.epoch ?? 1 });
  const reads = identityReadWorld(w, {
    database: options.database,
    ...(options.binding === undefined ? {} : { binding: options.binding }),
  });
  const script: Array<TaskOutcome | "throw" | "pending"> = [];
  const asked: Identity[] = [];
  const when: number[] = [];
  const releases: Array<(outcome: TaskOutcome) => void> = [];
  const start = (task: Partial<{ caller: string }> = {}): IdentityTask =>
    followIdentity({
      caller: task.caller ?? options.caller ?? "profile",
      identity: w.identity,
      online: reads.online,
      onOnline: reads.onOnline,
      service: reads.service,
      databasePending: reads.databasePending,
      onService: reads.onService,
      clock: reads.clock,
      timers: reads.timers,
      run: async (identity) => {
        asked.push(identity);
        when.push(reads.time());
        const next = script.shift() ?? "done";
        if (next === "throw") throw new Error("the task failed");
        if (next === "pending")
          return new Promise<TaskOutcome>((resolve) => {
            releases.push(resolve);
          });
        return next;
      },
    });
  const entry = (caller: string) => w.sync().read_retry_states[caller];
  return { w, reads, script, asked, when, releases, start, entry };
}

describe("the identity is a key, not an event", () => {
  test("a task that succeeded is never run again for that identity, however many times it is announced", async () => {
    const t = await setup();
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    for (let i = 0; i < 1_000; i += 1)
      t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    expect(t.reads.pendingTimers()).toBe(0);
    task.stop();
  });

  test("a task that failed is not run again by a notification of the same identity: only its own back-off asks again", async () => {
    const t = await setup();
    t.script.push("failure", "failure", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    for (let i = 0; i < 1_000; i += 1)
      t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    await advance(t.w, 1_999);
    expect(t.asked).toHaveLength(1);
    await advance(t.w, 1);
    expect(t.asked).toHaveLength(2);
    for (let i = 0; i < 1_000; i += 1)
      t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await advance(t.w, 3_999);
    expect(t.asked).toHaveLength(2);
    await advance(t.w, 1);
    expect(t.asked).toHaveLength(3);
    task.stop();
  });

  test("notifications that arrive while the task is running start nothing, and the announced identity may be a new object each time", async () => {
    const t = await setup();
    t.script.push("pending");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    for (let i = 0; i < 500; i += 1)
      t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.releases[0]?.("done");
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    task.stop();
  });

  test("a different epoch of the same account is new work, and the older one's answer is discarded", async () => {
    const t = await setup();
    t.script.push("pending", "done");
    const task = t.start();
    await settle(t.w);
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(t.w);
    expect(t.asked.map((identity) => identity.epoch)).toEqual([1, 2]);
    // The epoch-1 attempt reports a failure after the identity moved: it counts for nothing and schedules nothing.
    t.releases[0]?.("failure");
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(2);
    expect(t.entry("profile:1")).toBeUndefined();
    expect(t.reads.pendingTimers()).toBe(0);
    task.stop();
  });

  test("signing out ends the work and its timer; signing in again is new work", async () => {
    const t = await setup();
    t.script.push("failure");
    const task = t.start();
    await settle(t.w);
    expect(t.reads.pendingTimers()).toBe(1);
    t.w.identity.move({ account: null, epoch: 1 });
    await settle(t.w);
    expect(t.reads.pendingTimers()).toBe(0);
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    t.w.identity.move({ account: ACCOUNT, epoch: 3 });
    await settle(t.w);
    expect(t.asked.map((identity) => identity.epoch)).toEqual([1, 3]);
    task.stop();
  });

  test("nothing is asked while the page is offline, and `online` asks", async () => {
    const t = await setup();
    t.reads.goOffline();
    const task = t.start();
    await settle(t.w);
    t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(0);
    t.reads.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    task.stop();
  });

  test("a stopped task asks nothing more and leaves no timer", async () => {
    const t = await setup();
    t.script.push("failure");
    const task = t.start();
    await settle(t.w);
    task.stop();
    expect(t.reads.pendingTimers()).toBe(0);
    t.reads.goOnline();
    t.w.identity.move({ account: ACCOUNT, epoch: 9 });
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
  });
});

describe("network, time-out and 5xx failures (class 2)", () => {
  test("they back off 2 s doubling to 60 s and pause once the failure has lasted 180 s: eight attempts, then nothing", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("failure");
    const task = t.start();
    await settle(t.w);
    await advance(t.w, 182_000);
    // The eighth failure paused the caller: at that instant no timer is left to ask again.
    expect(t.asked).toHaveLength(8);
    expect(t.reads.pendingTimers()).toBe(0);
    await advance(t.w, 3_600_000);
    expect(t.when).toEqual([
      0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000, 182_000,
    ]);
    expect(t.entry("profile:1")).toMatchObject({ paused: true });
    expect(t.reads.pendingTimers()).toBe(0);
    task.stop();
  });

  test("`online` ends a pause by duration, and starts the schedule afresh", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("failure");
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(8);
    t.reads.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(9);
    expect(t.entry("profile:1")).toMatchObject({ paused: false });
    expect(t.entry("profile:1")?.backing_off_since).not.toBeNull();
    await advance(t.w, 2_000);
    expect(t.asked).toHaveLength(10);
    task.stop();
  });

  test("`online` ends a back-off at once, without waiting for the timer", async () => {
    const t = await setup();
    t.script.push("failure", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.reads.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    expect(t.reads.pendingTimers()).toBe(0);
    task.stop();
  });

  test("a task that throws is a counted failure, never a silent retry", async () => {
    const t = await setup();
    t.script.push("throw", "throw", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.entry("profile:1")).toMatchObject({ paused: false });
    expect(t.entry("profile:1")?.backing_off_since).not.toBeNull();
    await advance(t.w, 6_000);
    expect(t.asked).toHaveLength(3);
    task.stop();
  });

  test("its own success ends the back-off and removes the durable entry", async () => {
    const t = await setup();
    t.script.push("failure", "failure", "done");
    const task = t.start();
    await advance(t.w, 10_000);
    expect(t.asked).toHaveLength(3);
    // Nothing is left to remember: the entry is gone, which reads as the initial state.
    expect(t.entry("profile:1")).toBeUndefined();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(3);
    task.stop();
  });
});

describe("unrecognised answers (class 3)", () => {
  test("three consecutive ones pause that caller; time and `online` do not resume it, and its own retry does", async () => {
    const t = await setup();
    for (let i = 0; i < 10; i += 1) t.script.push("unrecognised");
    const task = t.start();
    await advance(t.w, 3_600_000);
    expect(t.when).toEqual([0, 2_000, 6_000]);
    expect(t.entry("profile:1")).toMatchObject({
      paused: true,
      unrecognised_streak: 3,
    });
    t.reads.goOnline();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(3);
    task.retry();
    await settle(t.w);
    expect(t.asked).toHaveLength(4);
    expect(t.entry("profile:1")).toMatchObject({
      paused: false,
      unrecognised_streak: 1,
    });
    task.stop();
  });

  test("a failure of the network between them does not reset the streak, and a success does", async () => {
    const t = await setup();
    t.script.push("unrecognised", "failure", "unrecognised", "unrecognised");
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(4);
    expect(t.entry("profile:1")).toMatchObject({
      paused: true,
      unrecognised_streak: 3,
    });
    task.stop();
    const u = await setup();
    u.script.push("unrecognised", "unrecognised", "done");
    const other = u.start();
    await advance(u.w, 600_000);
    // The success ended the streak: nothing is left, and it asks no more.
    expect(u.entry("profile:1")).toBeUndefined();
    expect(u.asked).toHaveLength(3);
    other.stop();
  });
});

describe("a read that was not sent, and a request the session closed", () => {
  test("quiet outcomes are asked again a few times on a short bounded schedule, uncounted, and then wait", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("quiet");
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.when).toEqual([
      0, 50, 150, 350, 750, 1_550, 2_550, 3_550, 4_550, 5_550,
    ]);
    expect(t.reads.pendingTimers()).toBe(0);
    // Nothing was counted, here or in the database.
    expect(t.w.sync().read_retry_states).toEqual({});
    // An event starts another bounded run.
    t.reads.goOnline();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(20);
    task.stop();
  });

  test("a closed request is not asked again until something changes: no timer, no count", async () => {
    const t = await setup({ database: false, binding: "absent" });
    t.script.push("wait", "done");
    const task = t.start();
    await settle(t.w);
    for (let i = 0; i < 500; i += 1)
      t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    expect(t.reads.pendingTimers()).toBe(0);
    expect(t.w.sync().read_retry_states).toEqual({});
    // The database opening is such a change.
    t.reads.openDatabase();
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    task.stop();
  });

  test("a wake that arrives while the task is running is not lost", async () => {
    const t = await setup({ database: false, binding: "absent" });
    t.script.push("pending", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    // The database opens while the first attempt is under way, and the attempt then says it had nothing to write to.
    t.reads.openDatabase();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.releases[0]?.("wait");
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    task.stop();
  });

  test("a database that opens for another account is not a wake", async () => {
    const t = await setup({ database: false });
    const other = "99999999-9999-4999-8999-999999999999";
    t.w.identity.move({ account: other, epoch: 1 });
    t.script.push("wait", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    // The world serves a database only for ACCOUNT: opening it is nothing to the identity of `other`.
    t.reads.openDatabase();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    task.stop();
  });
});

describe("the durable budget", () => {
  test("a healthy read writes nothing: no retry state, no transaction of the retry plans", async () => {
    const t = await setup();
    const seen = watchTransactions(t.w.env.idb);
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    expect(t.w.sync().read_retry_states).toEqual({});
    expect(seen.count("data.recordReadOutcome")).toBe(0);
    expect(seen.count("data.resumeReadCaller")).toBe(0);
    seen.stop();
    task.stop();
  });

  test("a reload does not restart the sustained-failure clock: a page that starts after 100 s of failure pauses 80 s later, not 180", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("failure");
    const first = t.start();
    await advance(t.w, 100_000);
    const before = t.asked.length;
    expect(t.entry("profile:1")?.backing_off_since).toBe(
      t.reads.clock.now() - 100_000,
    );
    first.stop();
    // The page reloads: a new runner over the same database, with nothing in memory.
    const reloaded = t.start();
    await settle(t.w);
    // It starts while a back-off is under way, so it waits the first step of the schedule before it asks.
    expect(t.asked).toHaveLength(before);
    await advance(t.w, 2_000);
    expect(t.asked).toHaveLength(before + 1);
    await advance(t.w, 3_600_000);
    expect(t.entry("profile:1")).toMatchObject({ paused: true });
    // Paused by the shared clock: the first failure was at 0, so the failure that has lasted 180 s is the first one after that. The
    // reload's own schedule (2, 4, 8, 16, 32, 60 s from 102 s) reaches it at 224 s; a clock that restarted at the reload would not
    // pause before 100 + 2 + 180 s.
    expect(t.when[t.when.length - 1]).toBe(224_000);
    reloaded.stop();
  });

  test("a page that starts while the durable record is paused asks nothing", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("failure");
    const first = t.start();
    await advance(t.w, 600_000);
    expect(t.entry("profile:1")).toMatchObject({ paused: true });
    const asked = t.asked.length;
    first.stop();
    const reloaded = t.start();
    await advance(t.w, 3_600_000);
    expect(t.asked).toHaveLength(asked);
    expect(t.reads.pendingTimers()).toBe(0);
    reloaded.stop();
  });

  test("two tabs share the budget: three unrecognised answers across both pause both", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("unrecognised");
    const a = t.start();
    const b = t.start();
    await advance(t.w, 3_600_000);
    // Each tab asked before it could know of the other's count, and the shared entry paused them after the third answer: at most
    // one more answer each, never the three each that separate memories would allow.
    expect(t.asked.length).toBeGreaterThanOrEqual(3);
    expect(t.asked.length).toBeLessThanOrEqual(4);
    expect(t.entry("profile:1")).toMatchObject({
      paused: true,
      unrecognised_streak: expect.any(Number),
    });
    expect(t.reads.pendingTimers()).toBe(0);
    a.stop();
    b.stop();
  });

  test("a new epoch is not held by an earlier sign-in's pause, and leaves nothing of it behind", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("unrecognised");
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.entry("profile:1")).toMatchObject({ paused: true });
    t.script.length = 0;
    t.script.push("unrecognised", "done");
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(t.w);
    expect(t.asked[t.asked.length - 1]?.epoch).toBe(2);
    // Counted afresh under its own entry; the older sign-in's entry is gone.
    expect(t.entry("profile:2")).toMatchObject({
      paused: false,
      unrecognised_streak: 1,
    });
    expect(t.entry("profile:1")).toBeUndefined();
    task.stop();
  });

  test("a success in a new epoch drops the entries an earlier sign-in left, in the same transaction, and writes nothing else", async () => {
    const t = await setup();
    t.w.setSync({
      read_retry_states: {
        "profile:1": {
          backing_off_since: 5,
          paused: true,
          unrecognised_streak: 0,
        },
      },
    });
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    const seen = watchTransactions(t.w.env.idb);
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.asked.map((identity) => identity.epoch)).toEqual([2]);
    expect(t.w.sync().read_retry_states).toEqual({});
    expect(seen.count("data.recordReadOutcome")).toBe(1);
    seen.stop();
    task.stop();
  });

  test("another caller's entry is never touched, by a failure, a success, `online` or a retry", async () => {
    const t = await setup();
    t.w.setSync({
      read_retry_states: {
        sync: { backing_off_since: 5, paused: true, unrecognised_streak: 0 },
        "households:h1": {
          backing_off_since: null,
          paused: false,
          unrecognised_streak: 2,
        },
        "device:1": {
          backing_off_since: 7,
          paused: false,
          unrecognised_streak: 0,
        },
      },
    });
    t.script.push("failure", "unrecognised", "done");
    const task = t.start();
    await advance(t.w, 10_000);
    t.reads.goOnline();
    task.retry();
    await advance(t.w, 10_000);
    const states = t.w.sync().read_retry_states;
    expect(states.sync).toEqual({
      backing_off_since: 5,
      paused: true,
      unrecognised_streak: 0,
    });
    expect(states["households:h1"]).toEqual({
      backing_off_since: null,
      paused: false,
      unrecognised_streak: 2,
    });
    // The other family (`device:`) is separate from `profile:`: its entry is not superseded by this caller's.
    expect(states["device:1"]).toEqual({
      backing_off_since: 7,
      paused: false,
      unrecognised_streak: 0,
    });
    task.stop();
  });

  test("with no database the page's memory counts, and nothing is created", async () => {
    const t = await setup({ database: false, binding: "absent" });
    for (let i = 0; i < 40; i += 1) t.script.push("unrecognised");
    const task = t.start();
    await advance(t.w, 3_600_000);
    expect(t.asked).toHaveLength(3);
    expect(t.reads.pendingTimers()).toBe(0);
    expect(t.w.sync().read_retry_states).toEqual({});
    task.stop();
  });

  test("what the page counted before its database opened is folded into the durable entry, not lost", async () => {
    const t = await setup({ database: false, binding: "absent" });
    for (let i = 0; i < 40; i += 1) t.script.push("unrecognised");
    const task = t.start();
    // The first two answers arrive with no database open.
    await advance(t.w, 2_500);
    expect(t.asked).toHaveLength(2);
    t.reads.openDatabase();
    await advance(t.w, 3_600_000);
    // The third answer, with the database open, pauses the caller durably: the count of two came with it.
    expect(t.asked).toHaveLength(3);
    expect(t.entry("profile:1")).toMatchObject({
      paused: true,
      unrecognised_streak: 3,
    });
    task.stop();
  });

  test("a late answer of an earlier epoch cannot change the durable entry of the current one", async () => {
    const t = await setup();
    t.script.push("pending", "done");
    const task = t.start();
    await settle(t.w);
    t.w.identity.move({ account: ACCOUNT, epoch: 2 });
    await settle(t.w);
    t.releases[0]?.("unrecognised");
    await advance(t.w, 600_000);
    expect(t.entry("profile:1")).toBeUndefined();
    expect(t.entry("profile:2")).toBeUndefined();
    task.stop();
  });

  test("a durable entry that cannot be written does not stop the schedule", async () => {
    const t = await setup();
    for (let i = 0; i < 40; i += 1) t.script.push("failure");
    const remove = t.w.env.idb.inject({
      match: (tx) => tx.label === "data.recordReadOutcome",
      mode: "error",
    });
    const task = t.start();
    await advance(t.w, 3_600_000);
    remove();
    // The memory counted: the same eight attempts, and then the pause.
    expect(t.asked).toHaveLength(8);
    expect(t.reads.pendingTimers()).toBe(0);
    task.stop();
  });
});

describe("R16 (revision 9): the budget is established before anything is asked", () => {
  const DURATION = {
    backing_off_since: 1,
    paused: true,
    unrecognised_streak: 0,
  };
  const UNRECOGNISED = {
    backing_off_since: null,
    paused: true,
    unrecognised_streak: 3,
  };

  test("nothing is asked while the page is still looking for the database; once it has opened, an unpaused caller asks", async () => {
    const t = await setup({ database: false });
    const task = t.start();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(0);
    t.reads.openDatabase();
    await advance(t.w, 600_000);
    expect(t.asked).toHaveLength(1);
    task.stop();
  });

  test.each([
    ["a pause by duration", DURATION],
    ["a pause by three unrecognised answers", UNRECOGNISED],
  ])(
    "%s that is already durable is honoured when the database binds late: zero requests",
    async (_name, entry) => {
      const t = await setup({ database: false });
      t.w.setSync({ read_retry_states: { "profile:1": entry } });
      const task = t.start();
      await advance(t.w, 60_000);
      t.reads.openDatabase();
      await advance(t.w, 3_600_000);
      expect(t.asked).toHaveLength(0);
      expect(t.entry("profile:1")).toEqual(entry);
      // Repeated remounts: each is a new page over the same database, asking nothing.
      task.stop();
      for (let i = 0; i < 3; i += 1) {
        const again = t.start();
        await advance(t.w, 3_600_000);
        again.stop();
      }
      expect(t.asked).toHaveLength(0);
    },
  );

  test("a durable pause by duration ends on `online` (and an unrecognised one does not), as the table says, after a late binding", async () => {
    for (const [entry, resumes] of [
      [DURATION, true],
      [UNRECOGNISED, false],
    ] as const) {
      const t = await setup({ database: false });
      t.w.setSync({ read_retry_states: { "profile:1": entry } });
      const task = t.start();
      t.reads.openDatabase();
      await advance(t.w, 600_000);
      expect(t.asked).toHaveLength(0);
      t.reads.goOnline();
      await advance(t.w, 600_000);
      expect(t.asked).toHaveLength(resumes ? 1 : 0);
      task.stop();
    }
  });

  test("the database genuinely absent (the page finished looking): the caller asks on its memory, and nothing is created", async () => {
    const t = await setup({ database: false });
    for (let i = 0; i < 20; i += 1) t.script.push("unrecognised");
    const task = t.start();
    await advance(t.w, 60_000);
    expect(t.asked).toHaveLength(0);
    t.reads.findNoDatabase();
    await advance(t.w, 3_600_000);
    expect(t.asked).toHaveLength(3);
    expect(t.w.sync().read_retry_states).toEqual({});
    task.stop();
  });

  test.each([
    ["before the pause", 2_500, 2],
    ["after the pause", 10_000, 3],
  ])(
    "a count made with no database is persisted when one appears, %s: a paused memory state is written although nothing will ask again",
    async (_name, wait, count) => {
      const t = await setup({ database: false, binding: "absent" });
      for (let i = 0; i < 20; i += 1) t.script.push("unrecognised");
      const first = t.start();
      await advance(t.w, wait);
      expect(t.asked).toHaveLength(count);
      t.reads.openDatabase();
      await advance(t.w, 3_600_000);
      expect(t.entry("profile:1")).toMatchObject({
        paused: true,
        unrecognised_streak: 3,
      });
      const asked = t.asked.length;
      expect(asked).toBe(3);
      // A reload starts another page, which finds the pause and asks nothing.
      first.stop();
      const reloaded = t.start();
      await advance(t.w, 3_600_000);
      expect(t.asked).toHaveLength(asked);
      reloaded.stop();
    },
  );

  test("a failure being backed off in memory is written when the database appears: the clock is the first failure's", async () => {
    const t = await setup({ database: false, binding: "absent" });
    for (let i = 0; i < 20; i += 1) t.script.push("failure");
    const task = t.start();
    await advance(t.w, 3_000);
    const first = t.reads.clock.now() - 3_000;
    expect(t.asked.length).toBeGreaterThanOrEqual(1);
    t.reads.openDatabase();
    await settle(t.w);
    expect(t.entry("profile:1")).toMatchObject({
      backing_off_since: first,
      paused: false,
    });
    task.stop();
  });

  test("a healthy caller leaves nothing behind when the database appears", async () => {
    const t = await setup({ database: false, binding: "absent" });
    const seen = watchTransactions(t.w.env.idb);
    const task = t.start();
    await advance(t.w, 60_000);
    expect(t.asked).toHaveLength(1);
    t.reads.openDatabase();
    await advance(t.w, 600_000);
    expect(t.w.sync().read_retry_states).toEqual({});
    expect(seen.count("data.persistReadRetry")).toBe(0);
    seen.stop();
    task.stop();
  });

  test("a database whose budget cannot be read asks nothing, counts nothing, and looks again a few times, then waits", async () => {
    const t = await setup();
    const remove = t.w.env.idb.inject({
      match: (tx) => tx.label === "data.readReadRetry",
      mode: "error",
    });
    const task = t.start();
    await advance(t.w, 3_600_000);
    expect(t.asked).toHaveLength(0);
    expect(t.w.sync().read_retry_states).toEqual({});
    expect(t.reads.pendingTimers()).toBe(0);
    remove();
    // `online` is an event that asks again; the budget is then read, and the caller asks.
    t.reads.goOnline();
    await advance(t.w, 60_000);
    expect(t.asked).toHaveLength(1);
    task.stop();
  });

  test("a memory count that cannot be written stays in force: the caller is still bounded, and nothing loops", async () => {
    const t = await setup({ database: false, binding: "absent" });
    for (let i = 0; i < 20; i += 1) t.script.push("unrecognised");
    const remove = t.w.env.idb.inject({
      match: (tx) => tx.label === "data.persistReadRetry",
      mode: "error",
    });
    const task = t.start();
    await advance(t.w, 10_000);
    expect(t.asked).toHaveLength(3);
    t.reads.openDatabase();
    await advance(t.w, 3_600_000);
    expect(t.asked).toHaveLength(3);
    expect(t.entry("profile:1")).toBeUndefined();
    remove();
    task.stop();
  });
});

describe("R16 (revision 9): a database that opens while an attempt is under way", () => {
  test("a wake (`online`) that arrives while the task is running is not lost: it asks again once the attempt has said it had nothing to do", async () => {
    const t = await setup();
    t.script.push("pending", "done");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.reads.goOnline();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.releases[0]?.("wait");
    await settle(t.w);
    expect(t.asked).toHaveLength(2);
    task.stop();
  });

  test("it receives what the page counted before it, together with that attempt's outcome (one transaction)", async () => {
    const t = await setup({ database: false, binding: "absent" });
    t.script.push("unrecognised", "unrecognised", "pending");
    const task = t.start();
    await advance(t.w, 2_500);
    expect(t.asked).toHaveLength(2);
    await advance(t.w, 5_000);
    expect(t.asked).toHaveLength(3);
    // The third attempt is under way when the database opens; its answer is the third unrecognised one.
    t.reads.openDatabase();
    await settle(t.w);
    t.releases[0]?.("unrecognised");
    await advance(t.w, 600_000);
    expect(t.entry("profile:1")).toMatchObject({
      paused: true,
      unrecognised_streak: 3,
    });
    expect(t.asked).toHaveLength(3);
    task.stop();
  });

  test("a healthy read that finishes after the database opened during it leaves nothing behind and writes nothing", async () => {
    const t = await setup({ database: false, binding: "absent" });
    const seen = watchTransactions(t.w.env.idb);
    t.script.push("pending");
    const task = t.start();
    await settle(t.w);
    expect(t.asked).toHaveLength(1);
    t.reads.openDatabase();
    await settle(t.w);
    t.releases[0]?.("done");
    await advance(t.w, 600_000);
    expect(t.w.sync().read_retry_states).toEqual({});
    expect(seen.count("data.recordReadOutcome")).toBe(0);
    expect(seen.count("data.persistReadRetry")).toBe(0);
    seen.stop();
    task.stop();
  });
});

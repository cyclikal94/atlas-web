// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type AccountService,
  DataRuntime,
  type RuntimeOpen,
  unorderedPersistence,
} from "../../src/data/engine/account-service";
import {
  followIdentity,
  type IdentityTask,
  type TaskOutcome,
} from "../../src/data/engine/identity-task";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncMessage } from "../../src/data/engine/sync-channel";
import type { ReadRetryState } from "../../src/data/model/types";
import { createDataEnv, type DataEnv } from "../../src/data/ui/env";
import { identityReadWorld } from "../support/data/identity-reads";
import { ACCOUNT, type PageWorld, pageWorld } from "../support/data/page-world";

/**
 * R59 completed (revision 38, `ended-service-binding`): an identity read is admitted only by the binding that stands in the turn that
 * asks. The review of revision 37 let the profile's first `/me` fail (the production 2 s back-off), then closed the bound service while
 * the retry was crossing its asynchronous budget adoption: `adopt()` answered `adopted` from its cached shortcut (awaiting it yields),
 * the controller unbound the service and cleared its look, and the stale answer reached `readMe` with no live binding (a second call,
 * `live: false`). `followIdentity` now reads the binding again synchronously immediately before it asks (`bound`): a binding that ended
 * is unknown and waits, a replacement is read first, a genuine absence keeps the memory path. Every awaited answer (a budget read, its
 * persistence, an outcome's record, an `online` or "Retry now" reset) is taken in only while the binding it was given for still stands.
 *
 * The oracle: the reads are counted at `readMe` and `currentDeviceId` (with the controller's binding at the moment of each call), the
 * durable budget is read back from the database, the controller's opens are counted (nothing reopens by itself), and time is the
 * production schedule on the world's clock (`random` pinned: the first back-off is exactly 2 s).
 *
 * FIXTURE evidence: the production controller, profile source, device mirror, `followIdentity` and plans over a real `DataRuntime` and
 * the double of IndexedDB, fake time; closures, replacements and held results are NAMED injections at the asynchronous seams.
 */
const PAUSE: ReadRetryState = {
  backing_off_since: null,
  paused: true,
  unrecognised_streak: 3,
};

type Boundary = "live" | "before-retry" | "across-adoption";
type Reader = "profile" | "device";

interface Composed {
  w: PageWorld;
  env: DataEnv;
  calls: Record<Reader, Array<{ time: number; live: boolean }>>;
  opens: () => number;
  closed: () => boolean;
  hint(): void;
  arm(): void;
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
  close(): void;
}

/**
 * The page as production composes it, with ONE reader under test whose first read fails (the other answers at once and is done). The
 * first retry timer fired after `arm()` ends the bound service at `boundary`: before its callback runs, or right after the callback
 * started the attempt (the attempt has awaited its cached adoption and not yet asked).
 */
async function composed(reader: Reader, boundary: Boundary): Promise<Composed> {
  const w = await pageWorld();
  const d = identityReadWorld(w);
  const runtime = new DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  let armed = false;
  let closed = false;
  let opens = 0;
  let env: DataEnv | null = null;
  const calls: Composed["calls"] = { profile: [], device: [] };
  const end = (): void => {
    if (closed) return;
    closed = true;
    env?.service()?.dispose("closed");
  };
  const messages = new Set<(message: SyncMessage) => void>();
  const answer = <T>(which: Reader, value: T) => {
    calls[which].push({
      time: d.time(),
      live: env?.service()?.live === true,
    });
    return which === reader && calls[which].length === 1
      ? ({ kind: "failure" } as const)
      : ({ kind: "ok", value } as const);
  };
  env = createDataEnv({
    identity: w.identity,
    online: { get: () => true, subscribe: () => () => undefined },
    onOnline: d.onOnline,
    loadRuntime: async () =>
      ({
        open: async (
          account: string,
          options: { create?: boolean },
        ): Promise<RuntimeOpen> => {
          opens += 1;
          return runtime.open(account, options);
        },
      }) as unknown as DataRuntime,
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: d.clock.now,
    }),
    timers: {
      clearTimeout: d.timers.clearTimeout,
      setTimeout: (fn: () => void, ms: number) =>
        d.timers.setTimeout(() => {
          const act = armed;
          armed = false;
          if (act && boundary === "before-retry") end();
          fn();
          // The callback has begun the attempt: it awaits its (cached) adoption and has not asked yet.
          if (act && boundary === "across-adoption") end();
        }, ms),
    },
    clock: {
      iso: () => new Date(d.clock.now()).toISOString(),
      now: d.clock.now,
      random: d.clock.random,
    },
    ids: { uuid: () => crypto.randomUUID() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => answer("profile", { id: ACCOUNT, username: "r38" }),
    currentDeviceId: async () => answer("device", "device-1"),
    channel: {
      post: () => undefined,
      subscribe: (listener) => {
        messages.add(listener);
        return () => {
          messages.delete(listener);
        };
      },
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await w.env.settle();
  };
  const bound = env;
  return {
    w,
    env: bound,
    calls,
    opens: () => opens,
    closed: () => closed,
    hint() {
      for (const listener of [...messages])
        listener({
          type: "data_changed",
          account: ACCOUNT,
          stores: ["drafts"],
        });
    },
    arm() {
      armed = true;
    },
    settle,
    async advance(ms) {
      await w.env.world.advance(ms);
      await settle();
    },
    close() {
      bound.dispose();
      runtime.dispose();
      w.service.dispose("closed");
    },
  };
}

describe("R59 (revision 38): a retry admits its read only over the binding that stands when it asks (production composition)", () => {
  for (const reader of ["profile", "device"] as const)
    for (const boundary of ["live", "before-retry", "across-adoption"] as const)
      test(`${reader}: the first read fails (2 s back-off); the bound service ${boundary === "live" ? "stays live (control): the retry asks once more, over the live binding" : boundary === "before-retry" ? "ends before the retry (control): nothing more is asked" : "ends ACROSS the retry's adoption: nothing more is asked"}; nothing reopens by itself and the durable history stands`, async () => {
        const c = await composed(reader, boundary);
        try {
          await c.settle();
          expect(c.calls[reader]).toHaveLength(1);
          expect(c.env.service()?.live).toBe(true);
          const other = reader === "profile" ? "device" : "profile";
          expect(c.calls[other]).toHaveLength(1);
          expect(
            c.w.sync().read_retry_states[`${reader}:1`]?.backing_off_since,
          ).not.toBeNull();
          const opens = c.opens();
          c.arm();
          await c.advance(65_000);
          expect(c.closed()).toBe(boundary !== "live");
          if (boundary === "live") {
            expect(c.calls[reader]).toHaveLength(2);
            expect(c.calls[reader][1]).toEqual({ time: 2_000, live: true });
          } else {
            expect(c.calls[reader]).toHaveLength(1);
            // Unknown, not absent: no binding, no reopening of its own, and the budget the database holds is the one recorded.
            expect(c.env.service()).toBeNull();
            expect(c.opens()).toBe(opens);
            expect(
              c.w.sync().read_retry_states[`${reader}:1`]?.backing_off_since,
            ).not.toBeNull();
          }
          // Every read ever made was made over a live binding, and the other reader asked nothing more.
          expect(c.calls[reader].every((call) => call.live)).toBe(true);
          expect(c.calls[other]).toHaveLength(1);
        } finally {
          c.close();
        }
      });

  test("replacement control: after the binding ended across the adoption, a hint makes the controller look again, the reader reads the NEW binding's budget, and its retry asks once over it", async () => {
    const c = await composed("profile", "across-adoption");
    try {
      await c.settle();
      c.arm();
      await c.advance(65_000);
      expect(c.calls.profile).toHaveLength(1);
      expect(c.env.service()).toBeNull();
      const before = c.env.service();
      c.hint();
      await c.advance(1_000);
      const replacement = c.env.service();
      expect(replacement?.live).toBe(true);
      expect(replacement).not.toBe(before);
      expect(c.calls.profile).toHaveLength(2);
      expect(c.calls.profile[1]?.live).toBe(true);
      // The success ended the back-off in the replacement's database.
      expect(c.w.sync().read_retry_states["profile:1"]).toBeUndefined();
      await c.advance(65_000);
      expect(c.calls.profile).toHaveLength(2);
    } finally {
      c.close();
    }
  });
});

/** A service whose result of `plan` (read or written) is held, AFTER its transaction completed, until released. */
function holding(service: AccountService) {
  let plan: string | null = null;
  const releases: Array<() => void> = [];
  const store = new Proxy(service.store, {
    get(target, key) {
      if (key !== "run") return Reflect.get(target, key, target);
      return async (p: { name: string }, ...rest: unknown[]) => {
        const value = await (target.run as (...a: unknown[]) => unknown)(
          p,
          ...rest,
        );
        if (plan !== null && p.name === plan) {
          plan = null;
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        return value;
      };
    },
  });
  return {
    service: new Proxy(service, {
      get: (target, key) =>
        key === "store" ? store : Reflect.get(target, key, target),
    }) as AccountService,
    /** The next result of `name` is held. */
    hold(name: string) {
      plan = name;
    },
    held: () => releases.length,
    release() {
      for (const release of releases.splice(0)) release();
    },
  };
}

/**
 * `followIdentity` over a binding the test moves: `service` is what the controller's `openServiceOf` would answer, `pending` its "not yet
 * known", and `notify()` its service-store notification (which a test may withhold, as a listener that has not run yet).
 */
async function schedules() {
  const w = await pageWorld();
  const d = identityReadWorld(w);
  const runtime = new DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  const a = holding(w.service);
  const binding: { service: AccountService | null; pending: boolean } = {
    service: a.service,
    pending: false,
  };
  const others: DataRuntime[] = [];
  const listeners = new Set<() => void>();
  // Runs once, synchronously, right after the next timer's callback (which begins an attempt that awaits its adoption).
  let afterTimer: (() => void) | null = null;
  const asked: Array<{ time: number; service: AccountService | null }> = [];
  const script: TaskOutcome[] = [];
  const start = (): IdentityTask =>
    followIdentity({
      caller: "profile",
      identity: w.identity,
      online: d.online,
      onOnline: d.onOnline,
      service: (account) => (account === ACCOUNT ? binding.service : null),
      databasePending: (account) => account === ACCOUNT && binding.pending,
      onService: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      clock: d.clock,
      timers: {
        clearTimeout: d.timers.clearTimeout,
        setTimeout: (fn: () => void, ms: number) =>
          d.timers.setTimeout(() => {
            fn();
            const after = afterTimer;
            afterTimer = null;
            after?.();
          }, ms),
      },
      run: async () => {
        asked.push({ time: d.time(), service: binding.service });
        return script.shift() ?? "done";
      },
    });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await w.env.settle();
  };
  return {
    w,
    d,
    a,
    binding,
    asked,
    script,
    start,
    settle,
    async advance(ms: number) {
      await w.env.world.advance(ms);
      await settle();
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
    onNextTimer(fn: () => void) {
      afterTimer = fn;
    },
    /** A's end as the controller sees it: unbound, its look cleared (unknown, not absent). */
    endA() {
      w.service.dispose("closed");
      binding.service = null;
      binding.pending = true;
    },
    /** Another live service of the same database (a later binding), held like A. */
    async replacement() {
      const opened = await runtime.open(ACCOUNT, { create: false });
      if (opened.kind !== "opened") throw new Error(`setup: ${opened.kind}`);
      expect(opened.service.live).toBe(true);
      return holding(opened.service);
    },
    /**
     * A live service of the same database opened by ANOTHER page's connection, so it stands while A ends (on A's own page, a second
     * runtime's service is ended with A's: they share the page's registry).
     */
    async elsewhere() {
      const page = w.env.page("B");
      page.identity.account = ACCOUNT;
      page.identity.epoch = 1;
      const other = new DataRuntime({
        identity: w.identity,
        persistence: unorderedPersistence,
        registry: page.registry,
        open: (account, options) => page.open(account, options),
      });
      others.push(other);
      const opened = await other.open(ACCOUNT, { create: false });
      if (opened.kind !== "opened") throw new Error(`setup: ${opened.kind}`);
      expect(opened.service.incarnationId).toBe(w.service.incarnationId);
      return holding(opened.service);
    },
    close() {
      runtime.dispose();
      for (const other of others) other.dispose();
      if (w.service.live) w.service.dispose("closed");
    },
  };
}

describe("R59 (revision 38): every awaited answer is the binding's that stood when it was given", () => {
  for (const close of [false, true])
    test(`the first budget read is held; ${close ? "the binding ENDS before it is delivered: nothing is asked, and the work waits for the binding" : "control, the binding stands: the work asks once"}`, async () => {
      const s = await schedules();
      try {
        s.a.hold("data.readReadRetry");
        const task = s.start();
        await s.settle();
        expect(s.a.held()).toBe(1);
        if (close) s.endA();
        s.a.release();
        await s.advance(65_000);
        expect(s.asked).toHaveLength(close ? 0 : 1);
        task.stop();
      } finally {
        s.close();
      }
    });

  for (const paused of [true, false])
    test(`the binding is REPLACED while the first budget read is held, and the replacement's database holds ${paused ? "a pause: nothing is asked" : "no pause (control): the work asks once, over the replacement, after reading its budget"}`, async () => {
      const s = await schedules();
      try {
        s.a.hold("data.readReadRetry");
        const task = s.start();
        await s.settle();
        s.endA();
        if (paused) s.w.setSync({ read_retry_states: { "profile:1": PAUSE } });
        const b = await s.replacement();
        s.binding.service = b.service;
        s.binding.pending = false;
        s.notify();
        s.a.release();
        await s.advance(65_000);
        // The premise: the replacement stood throughout (it was opened after A ended).
        expect(b.service.live).toBe(true);
        expect(s.asked).toHaveLength(paused ? 0 : 1);
        if (!paused) expect(s.asked[0]?.service).toBe(b.service);
        task.stop();
      } finally {
        s.close();
      }
    });

  for (const close of [false, true])
    test(`what the page counted before its database opened is persisted at the retry's adoption, and that write's result is held; ${close ? "the binding ENDS meanwhile: the retry asks nothing" : "control, the binding stands: the retry asks"}`, async () => {
      const s = await schedules();
      try {
        // No database yet, and the page has finished looking: the memory path counts a failure (2 s back-off).
        s.binding.service = null;
        s.script.push("failure");
        const task = s.start();
        await s.settle();
        expect(s.asked).toHaveLength(1);
        // The database appears without a notice reaching the reader yet: the retry's own adoption reads it, and writes what memory
        // knew (the back-off) into it.
        s.binding.service = s.a.service;
        s.a.hold("data.persistReadRetry");
        await s.advance(2_000);
        expect(s.a.held()).toBe(1);
        if (close) s.endA();
        s.a.release();
        await s.advance(65_000);
        expect(s.asked).toHaveLength(close ? 1 : 2);
        task.stop();
      } finally {
        s.close();
      }
    });

  for (const paused of [true, false])
    test(`the binding is replaced ACROSS a retry's cached adoption, and the reader is not told yet; the database holds ${paused ? "a pause another tab recorded: the replacement's budget is read first, and nothing is asked" : "no pause (control): the replacement's budget is read first, then the retry asks over it"}`, async () => {
      const s = await schedules();
      try {
        s.script.push("failure");
        const task = s.start();
        await s.settle();
        expect(s.asked).toHaveLength(1);
        if (paused) s.w.setSync({ read_retry_states: { "profile:1": PAUSE } });
        const b = await s.elsewhere();
        // At the 2 s retry, A ends and B is bound right after the timer's callback began the attempt (it awaits its cached
        // adoption of A): the controller's notice has not reached this reader.
        s.onNextTimer(() => {
          s.w.service.dispose("closed");
          s.binding.service = b.service;
        });
        await s.advance(65_000);
        // The premise: the replacement stood throughout, so the work's budget was the replacement's.
        expect(b.service.live).toBe(true);
        expect(s.asked).toHaveLength(paused ? 1 : 2);
        if (!paused) expect(s.asked[1]?.service).toBe(b.service);
        task.stop();
      } finally {
        s.close();
      }
    });

  test("a binding that ends and is then found ABSENT (the page finished looking: a wipe) keeps the memory path: the retry asks on what the page counted", async () => {
    const s = await schedules();
    try {
      s.script.push("failure");
      const task = s.start();
      await s.settle();
      expect(s.asked).toHaveLength(1);
      s.endA();
      s.binding.pending = false;
      s.notify();
      await s.advance(2_000);
      expect(s.asked).toHaveLength(2);
      expect(s.asked[1]?.service).toBeNull();
      task.stop();
    } finally {
      s.close();
    }
  });

  test("connectivity is read in the turn that asks: the page goes offline while the retry awaits its adoption, nothing is asked; `online` asks", async () => {
    const s = await schedules();
    try {
      s.script.push("failure");
      const task = s.start();
      await s.settle();
      expect(s.asked).toHaveLength(1);
      s.onNextTimer(() => s.d.goOffline());
      await s.advance(65_000);
      expect(s.asked).toHaveLength(1);
      s.d.goOnline();
      await s.settle();
      expect(s.asked).toHaveLength(2);
      task.stop();
    } finally {
      s.close();
    }
  });
});

describe("R59 (revision 38): a reset decided before an awaited write does not undo what happened meanwhile", () => {
  for (const outcome of [true, false])
    test(`\`online\` during a back-off, its durable resumption held; ${outcome ? "a retry fails meanwhile (a counted outcome): its own back-off stands, and nothing is asked early" : "nothing happens meanwhile (control): the back-off ends at once and the work asks"}`, async () => {
      const s = await schedules();
      try {
        s.script.push("failure", "failure");
        const task = s.start();
        await s.settle();
        expect(s.asked).toHaveLength(1);
        s.a.hold("data.resumeReadCallerOnOnline");
        if (outcome) await s.w.env.world.advance(1_900);
        s.d.goOnline();
        await s.settle();
        expect(s.a.held()).toBe(1);
        if (outcome) {
          // The 2 s retry runs while the resumption is held, and fails: the next back-off is 4 s from 2 s.
          await s.advance(100);
          expect(s.asked).toHaveLength(2);
          expect(s.asked[1]?.time).toBe(2_000);
        }
        s.a.release();
        await s.settle();
        expect(s.asked).toHaveLength(2);
        if (outcome) {
          await s.advance(3_999 - 100);
          expect(s.asked).toHaveLength(2);
          await s.advance(101);
          expect(s.asked).toHaveLength(3);
          expect(s.asked[2]?.time).toBe(6_000);
        } else expect(s.asked[1]?.time).toBe(0);
        task.stop();
      } finally {
        s.close();
      }
    });
});

describe("R59 (revision 38): an explicit retry's reset and another page's pause", () => {
  for (const schedule of ["ended", "adopted"] as const)
    test(`"Retry now" over a durable pause, its durable resumption held; ${schedule === "ended" ? "the binding merely ENDS meanwhile: the reset applies, and when the database returns its resumed entry is read and the caller asks" : "the work takes in ANOTHER budget meanwhile, holding a pause another page recorded after the resumption: that newer pause stands, and nothing is asked"}`, async () => {
      const s = await schedules();
      try {
        s.w.setSync({ read_retry_states: { "profile:1": PAUSE } });
        const task = s.start();
        await s.advance(65_000);
        expect(s.asked).toHaveLength(0);
        s.a.hold("data.resumeReadCaller");
        task.retry();
        await s.settle();
        expect(s.a.held()).toBe(1);
        // The resumption has committed (only its result is held).
        expect(s.w.sync().read_retry_states["profile:1"]?.paused ?? false).toBe(
          false,
        );
        if (schedule === "ended") {
          s.endA();
          s.a.release();
          await s.advance(1_000);
          expect(s.asked).toHaveLength(0);
          const b = await s.replacement();
          s.binding.service = b.service;
          s.binding.pending = false;
          s.notify();
          await s.advance(65_000);
          expect(b.service.live).toBe(true);
          expect(s.asked).toHaveLength(1);
          expect(s.asked[0]?.service).toBe(b.service);
        } else {
          s.w.setSync({ read_retry_states: { "profile:1": PAUSE } });
          const b = await s.elsewhere();
          s.binding.service = b.service;
          s.notify();
          await s.settle();
          s.a.release();
          await s.advance(65_000);
          expect(b.service.live).toBe(true);
          expect(s.asked).toHaveLength(0);
          expect(s.w.sync().read_retry_states["profile:1"]?.paused).toBe(true);
        }
        task.stop();
      } finally {
        s.close();
      }
    });

  test("two pages share the budget: a pause another page commits while this page's back-off timer is pending allows at most ONE overlapping request (its cached adoption is not re-read), whose recorded outcome takes the pause in; nothing more is asked", async () => {
    const s = await schedules();
    try {
      s.script.push("failure", "failure");
      const task = s.start();
      await s.settle();
      expect(s.asked).toHaveLength(1);
      // Another page's third unrecognised answer, committed while this page waits out its 2 s back-off.
      s.w.setSync({ read_retry_states: { "profile:1": PAUSE } });
      await s.advance(65_000);
      expect(s.asked).toHaveLength(2);
      expect(s.asked[1]?.time).toBe(2_000);
      expect(s.w.sync().read_retry_states["profile:1"]?.paused).toBe(true);
      task.stop();
    } finally {
      s.close();
    }
  });
});

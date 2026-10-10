// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DataRuntime,
  type RuntimeOpen,
  unorderedPersistence,
} from "../../src/data/engine/account-service";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncMessage } from "../../src/data/engine/sync-channel";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { ReadRetryState } from "../../src/data/model/types";
import { createDataEnv } from "../../src/data/ui/env";
import type { Identity, Store } from "../../src/session";
import {
  type IdentityReadWorld,
  identityReadWorld,
} from "../support/data/identity-reads";
import { ACCOUNT, type PageWorld, pageWorld } from "../support/data/page-world";

/**
 * R16 (revision 10): the controller's LOOK for the displayed account's database, when it fails. A look that fails (the runtime chunk
 * does not load, the listing or the open rejects) is not an answer: whether the database exists, and what durable retry budget it
 * holds, are unknown, so the identity readers keep waiting instead of starting a fresh in-memory budget (the review's unit probe: nine
 * `/me` requests over three mounts with a saved pause). The look is made again at the facts' re-read pace (`factsReadRetryMs`
 * doubling to `factsReadRetryMaxMs`), on `online`, on another tab's hint and on the person's own "Try again" (`retryLoad`); never on
 * every notification of the identity and never for an account the page has left. The production controller, runtime, plans and readers
 * over the double of IndexedDB, with fake time. Every fault is a NAMED injection; none is a genuine device failure.
 */
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAUSE = {
  backing_off_since: null,
  paused: true,
  unrecognised_streak: 3,
};

type Fault =
  | "none"
  | "load"
  | "open"
  | "absent"
  | "refused"
  | "abandoned"
  | "closed";

interface Look {
  w: PageWorld;
  d: IdentityReadWorld;
  env: ReturnType<typeof createDataEnv>;
  /** `only`: the fault applies to this account alone (another account's look is healthy). */
  faults: { mode: Fault; only?: string };
  counts: { loads: number; opens: Record<string, number> };
  asked: () => number;
  /** Delivers an `atlas-sync` hint, as another tab's write would. */
  hint(): void;
  online: Store<boolean> & { set(next: boolean): void };
  /** The identity as the page sees it: the same sign-in, a new object, as the session publishes at every evaluation. */
  republish(): void;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
}

async function look(
  options: {
    fault?: Fault;
    paused?: boolean;
    durable?: ReadRetryState;
    /**
     * Another account's look is answered with a LIVE service of its own, opened by a real runtime over the page (revision 37). Without it the
     * double answers every account with the world's one service, which belongs to the first account and has ENDED once the page leaves it:
     * since R59 a result whose service is not live is a failed look, not one that works.
     */
    liveOther?: boolean;
  } = {},
): Promise<Look> {
  const w = await pageWorld();
  const otherRuntime =
    options.liveOther === true
      ? new DataRuntime({
          identity: w.identity,
          persistence: unorderedPersistence,
          registry: w.page.registry,
          open: (account, openOptions) => w.page.open(account, openOptions),
        })
      : null;
  const d = identityReadWorld(w);
  const faults: { mode: Fault; only?: string } = {
    mode: options.fault ?? "none",
  };
  const counts = { loads: 0, opens: {} as Record<string, number> };
  if (options.paused === true || options.durable !== undefined)
    w.setSync({
      read_retry_states: {
        "profile:1": options.durable ?? PAUSE,
        "device:1": options.durable ?? PAUSE,
      },
    });
  let asked = 0;
  const onlineListeners = new Set<() => void>();
  let onlineNow = true;
  const online = {
    get: () => onlineNow,
    subscribe: (listener: () => void) => {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    set(next: boolean) {
      onlineNow = next;
      for (const listener of [...onlineListeners]) listener();
    },
  };
  const messages = new Set<(message: SyncMessage) => void>();
  const runtime = {
    open: async (account: string): Promise<RuntimeOpen> => {
      counts.opens[account] = (counts.opens[account] ?? 0) + 1;
      const faulty = faults.only === undefined || faults.only === account;
      if (faulty && faults.mode === "open")
        throw new Error("listing unavailable");
      if (faulty && faults.mode === "absent") return { kind: "absent" };
      if (faulty && faults.mode === "refused")
        return { kind: "refused", reason: "identity" };
      if (faulty && faults.mode === "abandoned")
        return { kind: "refused", reason: "abandoned" };
      if (faulty && faults.mode === "closed")
        return { kind: "refused", reason: "closed" };
      if (otherRuntime !== null && account !== ACCOUNT)
        return otherRuntime.open(account, { create: true });
      return { kind: "opened", service: w.service, created: false };
    },
  } as unknown as DataRuntime;
  const env = createDataEnv({
    identity: w.identity,
    online,
    onOnline: d.onOnline,
    loadRuntime: async () => {
      counts.loads += 1;
      if (faults.mode === "load") throw new Error("chunk load failed");
      return runtime;
    },
    quota: createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: 1e9 }) },
      now: d.clock.now,
    }),
    timers: d.timers,
    clock: {
      iso: () => new Date(d.clock.now()).toISOString(),
      now: d.clock.now,
      random: d.clock.random,
    },
    ids: { uuid: () => crypto.randomUUID() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => {
      asked += 1;
      return { kind: "unrecognised" };
    },
    currentDeviceId: async () => ({ kind: "closed" }),
    channel: {
      post: () => undefined,
      subscribe: (listener) => {
        messages.add(listener);
        return () => messages.delete(listener);
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await w.env.settle();
  };
  return {
    w,
    d,
    env,
    faults,
    counts,
    asked: () => asked,
    hint: () => {
      for (const listener of [...messages])
        listener({ type: "data_changed", account: ACCOUNT, stores: [] });
    },
    online,
    republish: () => {
      const current = w.identity.get() as Identity;
      w.identity.move({ account: current.account_id, epoch: current.epoch });
    },
    settle,
    advance: async (ms) => {
      await w.env.world.advance(ms);
      await settle();
    },
  };
}

describe("a look that fails asks nothing, whatever the budget in the database", () => {
  test.each([
    ["load", "the runtime chunk does not load"],
    ["open", "the listing or the open rejects"],
  ] as const)(
    "%s (%s) with a durable pause: no request in an hour, across three mounts; the failure is visible",
    async (fault, _why) => {
      for (let mount = 0; mount < 3; mount += 1) {
        const t = await look({ fault, paused: true });
        await t.settle();
        await t.advance(3_600_000);
        expect(t.asked()).toBe(0);
        expect(t.env.summary.get()).toMatchObject({ status: "unavailable" });
        expect(t.env.queue.get()).toMatchObject({ status: "unavailable" });
        expect(t.env.service()).toBeNull();
        t.env.dispose();
      }
    },
  );

  test.each([
    ["load", "the runtime chunk does not load"],
    ["open", "the listing or the open rejects"],
  ] as const)(
    "%s (%s) with no durable budget at all: still nothing is asked while the look fails, because the database may hold one",
    async (fault, _why) => {
      const t = await look({ fault });
      await t.settle();
      await t.advance(3_600_000);
      expect(t.asked()).toBe(0);
      t.env.dispose();
    },
  );

  test("the reviewer's controls: a readable paused database asks nothing, genuine absence asks on the page's memory (three answers, each mount), a healthy database asks", async () => {
    const paused = await look({ paused: true });
    await paused.settle();
    await paused.advance(3_600_000);
    expect(paused.asked()).toBe(0);
    paused.env.dispose();

    let asked = 0;
    for (let mount = 0; mount < 3; mount += 1) {
      const absent = await look({ fault: "absent" });
      await absent.settle();
      await absent.advance(3_600_000);
      asked += absent.asked();
      absent.env.dispose();
    }
    expect(asked).toBe(9);

    const healthy = await look();
    await healthy.settle();
    await healthy.advance(3_600_000);
    expect(healthy.asked()).toBeGreaterThanOrEqual(1);
    healthy.env.dispose();
  });
});

describe("the look is made again, paced, and only the look", () => {
  test.each([["load"], ["open"]] as const)(
    "%s: 250 ms doubling to 10 s, then one attempt per 10 s, and nothing else is scheduled",
    async (fault) => {
      const t = await look({ fault, paused: true });
      await t.settle();
      const attempts = () =>
        fault === "load" ? t.counts.loads : (t.counts.opens[ACCOUNT] ?? 0);
      // The first look at once; then after 250 ms, 500 ms, 1 s, 2 s, 4 s, 8 s and 10 s.
      expect(attempts()).toBe(1);
      await t.advance(200);
      expect(attempts()).toBe(1);
      await t.advance(100);
      expect(attempts()).toBe(2);
      await t.advance(500);
      expect(attempts()).toBe(3);
      await t.advance(16_000);
      expect(attempts()).toBeLessThanOrEqual(8);
      const at = DATA_CONFIG.factsReadRetryMaxMs;
      const before = attempts();
      await t.advance(at * 6);
      expect(attempts() - before).toBe(6);
      // One timer, the look's, is all that a failure keeps.
      expect(t.d.pendingTimers()).toBe(1);
      await t.advance(3_600_000);
      expect(attempts()).toBeLessThanOrEqual(400);
      expect(t.asked()).toBe(0);
      t.env.dispose();
    },
  );

  test("a storm of notifications of the same identity does not make the look again", async () => {
    const quiet = await look({ fault: "load", paused: true });
    await quiet.settle();
    await quiet.advance(60_000);
    const baseline = quiet.counts.loads;
    quiet.env.dispose();

    const storm = await look({ fault: "load", paused: true });
    await storm.settle();
    for (let i = 0; i < 300; i += 1) {
      storm.republish();
      if (i % 50 === 0) await storm.settle();
    }
    await storm.advance(60_000);
    for (let i = 0; i < 300; i += 1) storm.republish();
    await storm.settle();
    expect(storm.counts.loads).toBe(baseline);
    storm.env.dispose();
  });

  test("`online` looks again at once; so does another tab's hint; neither asks anything while the look still fails", async () => {
    const t = await look({ fault: "load", paused: true });
    await t.settle();
    const first = t.counts.loads;
    t.online.set(false);
    t.online.set(true);
    await t.settle();
    expect(t.counts.loads).toBeGreaterThan(first);
    const second = t.counts.loads;
    t.hint();
    await t.settle();
    expect(t.counts.loads).toBeGreaterThan(second);
    expect(t.asked()).toBe(0);
    // The failed look never holds two timers.
    expect(t.d.pendingTimers()).toBeLessThanOrEqual(1);
    t.env.dispose();
  });

  test("the person's `Try again` (retryLoad) looks at once and recovers: a durable pause is then read and honoured", async () => {
    const t = await look({ fault: "open", paused: true });
    await t.settle();
    await t.advance(30_000);
    t.faults.mode = "none";
    const before = t.counts.opens[ACCOUNT] ?? 0;
    t.env.actions.retryLoad();
    await t.settle();
    expect(t.counts.opens[ACCOUNT]).toBeGreaterThan(before);
    expect(t.env.service()).not.toBeNull();
    await t.advance(3_600_000);
    expect(t.asked()).toBe(0);
    // The look is over: it is not made again.
    const done = t.counts.opens[ACCOUNT];
    await t.advance(600_000);
    expect(t.counts.opens[ACCOUNT]).toBe(done);
    t.env.dispose();
  });

  test.each([["load"], ["open"]] as const)(
    "%s fails, then recovers on its own pace: a healthy database is read once, a paused one never, and the failure notice goes",
    async (fault) => {
      const healthy = await look({ fault });
      await healthy.settle();
      await healthy.advance(45_000);
      expect(healthy.asked()).toBe(0);
      healthy.faults.mode = "none";
      await healthy.advance(15_000);
      expect(healthy.env.service()).not.toBeNull();
      expect(healthy.asked()).toBeGreaterThanOrEqual(1);
      expect(healthy.env.summary.get().status).not.toBe("unavailable");
      healthy.env.dispose();

      const paused = await look({ fault, paused: true });
      await paused.settle();
      await paused.advance(45_000);
      paused.faults.mode = "none";
      await paused.advance(15_000);
      expect(paused.env.service()).not.toBeNull();
      await paused.advance(3_600_000);
      expect(paused.asked()).toBe(0);
      paused.env.dispose();
    },
  );

  test("a failure, then genuine absence: the page asks on its memory, once it KNOWS there is none", async () => {
    const t = await look({ fault: "open" });
    await t.settle();
    await t.advance(30_000);
    expect(t.asked()).toBe(0);
    t.faults.mode = "absent";
    await t.advance(15_000);
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    expect(t.env.service()).toBeNull();
    t.env.dispose();
  });

  test("a mixed failure (the chunk, then the open) is one failure: the look goes on until it lands", async () => {
    const t = await look({ fault: "load", paused: true });
    await t.settle();
    await t.advance(20_000);
    t.faults.mode = "open";
    await t.advance(40_000);
    expect(t.asked()).toBe(0);
    expect(
      Object.values(t.counts.opens).reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0);
    t.faults.mode = "none";
    await t.advance(30_000);
    expect(t.env.service()).not.toBeNull();
    await t.advance(3_600_000);
    expect(t.asked()).toBe(0);
    t.env.dispose();
  });

  test("a failed look does not outlive its account: leaving, or another account, ends it", async () => {
    const left = await look({ fault: "load", paused: true });
    await left.settle();
    await left.advance(30_000);
    left.w.identity.move({ account: null, epoch: 1 });
    await left.settle();
    // At once, before the timer that was pending could have fired: leaving the account cancels it.
    expect(left.d.pendingTimers()).toBe(0);
    const stopped = left.counts.loads;
    await left.advance(3_600_000);
    expect(left.counts.loads).toBe(stopped);
    expect(left.d.pendingTimers()).toBe(0);
    left.env.dispose();

    const other = await look({ fault: "open", paused: true });
    await other.settle();
    await other.advance(30_000);
    const mine = other.counts.opens[ACCOUNT] ?? 0;
    other.w.identity.move({ account: OTHER, epoch: 1 });
    await other.settle();
    expect(other.counts.opens[OTHER]).toBe(1);
    await other.advance(120_000);
    // The old account is never looked at again; the new one is looked at on its own pace.
    expect(other.counts.opens[ACCOUNT]).toBe(mine);
    expect(other.counts.opens[OTHER]).toBeGreaterThan(1);
    other.env.dispose();
  });

  test("a failure for one account is not remembered against another, or against the same account later: A fails, B is looked at, A is looked at again", async () => {
    // Adapted in revision 37 (labelled): the other account's look is answered with a LIVE service of its own (`liveOther`). The original double
    // answered it with the first account's service, ended once the page left that account, and the controller bound that dead service as a
    // look that worked: the defect R59 removes. Answered dead now, the look is a FAILED one whose own pace forgets the first account's failure
    // anyway, so the case could no longer tell whether the move to another account forgets it (MU-325 survived). The assertions are the original.
    const t = await look({ fault: "open", paused: true, liveOther: true });
    t.faults.only = ACCOUNT;
    await t.settle();
    await t.advance(30_000);
    expect(t.env.service()).toBeNull();
    // The page moves to another account, whose look works: what is asked here is that the look is made, and that the first account's failure
    // does not stand in its way.
    t.w.identity.move({ account: OTHER, epoch: 1 });
    await t.settle();
    expect(t.counts.opens[OTHER]).toBe(1);
    expect(t.env.service()?.live).toBe(true);
    // And back: the failure of the first look has been forgotten, so the look is made again (here it still fails, and is paced).
    const before = t.counts.opens[ACCOUNT] ?? 0;
    t.w.identity.move({ account: ACCOUNT, epoch: 1 });
    await t.settle();
    expect(t.counts.opens[ACCOUNT]).toBe(before + 1);
    await t.advance(1_000);
    expect(t.counts.opens[ACCOUNT]).toBeGreaterThan(before + 1);
    t.env.dispose();
  });

  test("a recovered look leaves nothing behind: when the service later ends, the next notification of the identity looks again", async () => {
    const t = await look({ fault: "open", paused: true });
    await t.settle();
    await t.advance(20_000);
    t.faults.mode = "none";
    await t.advance(15_000);
    expect(t.env.service()).not.toBeNull();
    const before = t.counts.opens[ACCOUNT] ?? 0;
    t.w.service.dispose("latched");
    await t.settle();
    expect(t.env.service()).toBeNull();
    t.republish();
    await t.settle();
    expect(t.counts.opens[ACCOUNT]).toBeGreaterThan(before);
    t.env.dispose();
  });

  test("disposing the controller cancels the look", async () => {
    const t = await look({ fault: "open", paused: true });
    await t.settle();
    await t.advance(30_000);
    expect(t.d.pendingTimers()).toBe(1);
    t.env.dispose();
    // At once, before the timer that was pending could have fired: disposing the controller cancels it.
    expect(t.d.pendingTimers()).toBe(0);
    const stopped = t.counts.opens[ACCOUNT];
    await t.advance(3_600_000);
    expect(t.counts.opens[ACCOUNT]).toBe(stopped);
    expect(t.d.pendingTimers()).toBe(0);
  });

  test("a runtime disposed UNDER a live controller answers `abandoned`, which is a failed look and never an absence (R35): the screens say they cannot read, nothing is asked, and each paced look loads a runtime afresh until one binds", async () => {
    // A durable pause in the database: taking the failure for "no database" would start a fresh in-memory budget and ask `/me`.
    const t = await look({ fault: "abandoned", paused: true });
    await t.settle();
    expect(t.counts.loads).toBe(1);
    expect(t.env.queue.get()).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    expect(t.env.summary.get()).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    expect(t.env.service()).toBeNull();
    await t.advance(10_000);
    expect(t.asked()).toBe(0);
    // The runtime that answered `abandoned` was dropped: every paced look asks for a new one, it is not asked the same one for ever.
    expect(t.counts.loads).toBeGreaterThan(1);
    t.faults.mode = "none";
    await t.advance(20_000);
    expect(t.env.service()).not.toBeNull();
    t.env.dispose();
  });

  test("an open that a CLOSURE of the account ended answers `closed`, which is a failed look and never an absence (R37): the screens say they cannot read, nothing is asked, the HEALTHY runtime is kept and the paced look binds once the closure is over", async () => {
    // A durable pause in the database: taking the failure for "no database" would start a fresh in-memory budget and ask `/me`.
    const t = await look({ fault: "closed", paused: true });
    await t.settle();
    expect(t.counts.loads).toBe(1);
    expect(t.env.queue.get()).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    expect(t.env.summary.get()).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    expect(t.env.service()).toBeNull();
    await t.advance(10_000);
    expect(t.asked()).toBe(0);
    // The runtime is healthy (the account was closed under one open, not the runtime): it is asked again on the pace, not reloaded.
    expect(t.counts.opens[ACCOUNT]).toBeGreaterThan(1);
    expect(t.counts.loads).toBe(1);
    t.faults.mode = "none";
    await t.advance(20_000);
    expect(t.env.service()).not.toBeNull();
    t.env.dispose();
  });

  test("a look that is REFUSED (the identity moved while it ran) is an answer, not a failure: it is not made again on a timer", async () => {
    const t = await look({ fault: "refused" });
    await t.settle();
    await t.advance(3_600_000);
    expect(t.counts.opens[ACCOUNT]).toBe(1);
    expect(t.d.pendingTimers()).toBeLessThanOrEqual(1);
    t.env.dispose();
  });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type AccountService,
  DataRuntime,
  type RuntimeOpen,
  unorderedPersistence,
} from "../../src/data/engine/account-service";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import type { SyncMessage } from "../../src/data/engine/sync-channel";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { ReadRetryState } from "../../src/data/model/types";
import { createDataEnv, type DataEnv } from "../../src/data/ui/env";
import {
  type IdentityReadWorld,
  identityReadWorld,
} from "../support/data/identity-reads";
import { ACCOUNT, type PageWorld, pageWorld } from "../support/data/page-world";

/**
 * R59 (revision 37): the controller admits an opened result only while its service is LIVE. The review of revision 36 held a real
 * `DataRuntime.open()` result at the asynchronous seam and closed its service (`dispose("closed")`) before the controller received it:
 * `attach()` looked only at the result's kind, bound the dead service and declared the look finished, so `databasePending` said "no
 * database" while `openServiceOf` had none to give, and the profile reader took its in-memory path over a database that holds a durable
 * pause (three `/me` requests in 65 s, the pause untouched). Its end had already been announced, so no `onEnd` ever undid the binding, and
 * a hint could not either (`reprobe` opened only with no binding).
 *
 * The oracle: the readers' requests are counted at `readMe` and `currentDeviceId` (the durable pause forbids every one), the pause is read
 * back from the database, every service the controller publishes is checked for liveness AT publication, the channel's listeners are
 * counted (a facade subscribes one), and the opens are counted and timed at the opener. The production pacing (`factsReadRetryMs` doubling
 * to `factsReadRetryMaxMs`) bounds the recovery.
 *
 * FIXTURE evidence: the production controller, a real `DataRuntime` over the double of IndexedDB and the page's registry, fake time; the
 * closure is a NAMED injection at the open's delivery seam (not a naturally occurring browser close).
 */
const PAUSE: ReadRetryState = {
  backing_off_since: null,
  paused: true,
  unrecognised_streak: 3,
};
const FIRST = DATA_CONFIG.factsReadRetryMs;
const CAP = DATA_CONFIG.factsReadRetryMaxMs;

/** What happens to an opened result's service before the controller receives it. */
type End = "none" | "closed" | "latched";

interface Late {
  w: PageWorld;
  d: IdentityReadWorld;
  env: DataEnv;
  runtime: DataRuntime;
  /** Which opens (1-based) have their service ended before delivery, and how. */
  ending: { end: End; opens: (n: number) => boolean };
  opens: number[];
  /** The services the opener handed over, in order. */
  handed: AccountService[];
  /** Every service the controller published (`serviceStore`), and whether it was live when published. */
  published: Array<{ service: AccountService | null; live: boolean | null }>;
  profile: () => number;
  device: () => number;
  listeners: () => number;
  hint(stores?: string[]): void;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  close(): void;
}

async function late(
  ending: Late["ending"],
  /** Called before the controller starts: a listener it adds is told of every publication BEFORE the controller's readers are. */
  beforeStart?: (env: DataEnv) => void,
): Promise<Late> {
  const w = await pageWorld();
  const d = identityReadWorld(w);
  w.setSync({ read_retry_states: { "profile:1": PAUSE, "device:1": PAUSE } });
  const runtime = new DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  const opens: number[] = [];
  const handed: AccountService[] = [];
  let profile = 0;
  let device = 0;
  const messages = new Set<(message: SyncMessage) => void>();
  const env = createDataEnv(
    {
      identity: w.identity,
      online: { get: () => true, subscribe: () => () => undefined },
      onOnline: d.onOnline,
      loadRuntime: async () =>
        ({
          open: async (
            account: string,
            options: { create?: boolean },
          ): Promise<RuntimeOpen> => {
            opens.push(d.time());
            const result = await runtime.open(account, options);
            if (result.kind === "opened") {
              handed.push(result.service);
              // The named injection: the closure lands while the result is on its way to the controller.
              if (ending.opens(opens.length)) {
                if (ending.end === "closed") result.service.dispose("closed");
                if (ending.end === "latched")
                  w.page.registry.setLatch(account, "closed_for_deletion");
              }
            }
            return result;
          },
        }) as unknown as DataRuntime,
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
        profile += 1;
        return { kind: "unrecognised" };
      },
      currentDeviceId: async () => {
        device += 1;
        return { kind: "unrecognised" };
      },
      channel: {
        post: () => undefined,
        subscribe: (listener) => {
          messages.add(listener);
          return () => {
            messages.delete(listener);
          };
        },
      },
    },
    { start: false },
  );
  const published: Late["published"] = [];
  env.serviceStore.subscribe(() => {
    const service = env.serviceStore.get();
    published.push({ service, live: service === null ? null : service.live });
  });
  beforeStart?.(env);
  env.start();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await w.env.settle();
  };
  return {
    w,
    d,
    env,
    runtime,
    ending,
    opens,
    handed,
    published,
    profile: () => profile,
    device: () => device,
    listeners: () => messages.size,
    hint(stores = ["sync_state"]) {
      for (const listener of [...messages])
        listener({ type: "data_changed", account: ACCOUNT, stores });
    },
    settle,
    async advance(ms) {
      await settle();
      await w.env.world.advance(ms);
      await settle();
    },
    close() {
      env.dispose();
      runtime.dispose();
      w.service.dispose("closed");
    },
  };
}

/** The durable pause the readers must honour, as the database holds it now. */
const durable = (t: Late) => t.w.sync().read_retry_states;
const live = (t: Late): boolean => t.env.service()?.live === true;

describe("R59: an opened result is admitted only while its service is live", () => {
  test("control: a result delivered live binds once, the readers honour the durable pause, the facade subscribes once", async () => {
    const t = await late({ end: "none", opens: () => false });
    try {
      await t.settle();
      expect(live(t)).toBe(true);
      expect(t.env.service()).toBe(t.handed[0]);
      expect(t.env.outbox()).not.toBeNull();
      // The controller's own channel subscription and its facade's.
      expect(t.listeners()).toBe(2);
      await t.advance(65_000);
      expect({ profile: t.profile(), device: t.device() }).toEqual({
        profile: 0,
        device: 0,
      });
      expect(t.opens.length).toBe(1);
      expect(durable(t)).toEqual({ "profile:1": PAUSE, "device:1": PAUSE });
    } finally {
      t.close();
    }
  });

  for (const end of ["closed", "latched"] as const)
    test(`a result whose service was ${end === "closed" ? "closed" : "latched (a closure of the account)"} before delivery is never bound: no facade, no request, the pause kept, and the paced look binds the next live service`, async () => {
      const t = await late({ end, opens: (n) => n === 1 });
      try {
        await t.settle();
        // Delivered dead: nothing bound, no facade (so no subscription of one), the screens say they could not read.
        expect(t.handed[0]?.live).toBe(false);
        expect(t.env.service()).toBeNull();
        expect(t.env.outbox()).toBeNull();
        expect(t.listeners()).toBe(1);
        expect(t.env.queue.get()).toMatchObject({
          status: "unavailable",
          reason: "error",
        });
        // The look is made again on the paced schedule (never sooner) and binds the next open's live service.
        await t.advance(FIRST - 1);
        expect(t.opens.length).toBe(1);
        await t.advance(CAP);
        expect(t.opens.length).toBe(2);
        expect(live(t)).toBe(true);
        expect(t.env.service()).toBe(t.handed[1]);
        expect(t.env.service()).not.toBe(t.handed[0]);
        expect(t.listeners()).toBe(2);
        await t.advance(65_000);
        // No service the controller ever published was dead when it published it.
        expect(t.published.filter((p) => p.live === false)).toEqual([]);
        expect({ profile: t.profile(), device: t.device() }).toEqual({
          profile: 0,
          device: 0,
        });
        expect(durable(t)).toEqual({ "profile:1": PAUSE, "device:1": PAUSE });
        expect(t.opens.length).toBe(2);
      } finally {
        t.close();
      }
    });

  test("while every result arrives dead, the readers ask nothing and the looks stay on the production pace (never faster, never past the cap); the next live one binds", async () => {
    const ending: Late["ending"] = { end: "closed", opens: () => true };
    const t = await late(ending);
    try {
      await t.advance(65_000);
      expect(t.env.service()).toBeNull();
      expect({ profile: t.profile(), device: t.device() }).toEqual({
        profile: 0,
        device: 0,
      });
      expect(durable(t)).toEqual({ "profile:1": PAUSE, "device:1": PAUSE });
      const gaps = t.opens.slice(1).map((at, i) => at - (t.opens[i] ?? 0));
      expect(gaps.length).toBeGreaterThan(3);
      expect(gaps[0]).toBeGreaterThanOrEqual(FIRST);
      for (let i = 1; i < gaps.length; i += 1)
        expect(gaps[i] ?? 0).toBeGreaterThanOrEqual(gaps[i - 1] ?? 0);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(CAP);
      // Bounded: 65 s at this pace is a handful of opens, not a loop.
      expect(t.opens.length).toBeLessThanOrEqual(14);
      expect(t.published.filter((p) => p.live === false)).toEqual([]);
      ending.opens = () => false;
      await t.advance(CAP);
      expect(live(t)).toBe(true);
      expect(t.profile()).toBe(0);
    } finally {
      t.close();
    }
  });

  test("the person's Try again (retryLoad) after a dead result looks at once and binds, without waiting for the pace", async () => {
    const t = await late({ end: "closed", opens: (n) => n === 1 });
    try {
      await t.settle();
      expect(t.env.service()).toBeNull();
      t.env.actions.retryLoad();
      await t.settle();
      expect(t.opens.length).toBe(2);
      expect(live(t)).toBe(true);
      expect(t.profile()).toBe(0);
    } finally {
      t.close();
    }
  });

  test("a hint after a dead result looks again at once (no binding stands in its way) and binds", async () => {
    const t = await late({ end: "closed", opens: (n) => n === 1 });
    try {
      await t.settle();
      expect(t.env.service()).toBeNull();
      t.hint();
      await t.settle();
      expect(t.opens.length).toBe(2);
      expect(live(t)).toBe(true);
      expect(t.profile()).toBe(0);
    } finally {
      t.close();
    }
  });
});

describe("R59: a service that ends AFTER it was bound", () => {
  test("its end unbinds at once: no dead binding, the readers wait (no request over the pause), nothing reopens by itself, and a hint binds the next live service", async () => {
    const t = await late({ end: "none", opens: () => false });
    try {
      await t.settle();
      const first = t.env.service();
      expect(first?.live).toBe(true);
      first?.dispose("closed");
      await t.settle();
      expect(t.env.service()).toBeNull();
      expect(t.env.outbox()).toBeNull();
      // The facade's subscription went with its binding.
      expect(t.listeners()).toBe(1);
      await t.advance(65_000);
      // Nothing looks again by itself after a binding ends (a wipe's latch must not be undone by the page): the readers wait.
      expect(t.opens.length).toBe(1);
      expect({ profile: t.profile(), device: t.device() }).toEqual({
        profile: 0,
        device: 0,
      });
      t.hint();
      await t.settle();
      expect(live(t)).toBe(true);
      expect(t.env.service()).not.toBe(first);
      await t.advance(65_000);
      expect(t.profile()).toBe(0);
      expect(durable(t)).toEqual({ "profile:1": PAUSE, "device:1": PAUSE });
    } finally {
      t.close();
    }
  });
});

describe("R59: a bound service that is no longer live but has not announced its end (the second layer)", () => {
  /**
   * In production a latch ends every runtime's service synchronously, so this state does not last; it is made here by a VIEW of a real
   * service whose `live` the test turns off without any end (a double of the window between a latch and its end). Absence is known only
   * when the look finished and bound nothing: the readers must wait over such a binding, and a hint must look again, as `follow` does.
   */
  test("the readers wait (no request over the pause), and a hint looks again and binds the live service", async () => {
    let dead = false;
    let viewed: AccountService | null = null;
    // The binding stops being live when the controller publishes it, before its readers have looked at it: the window a latch could land
    // in between the bind and its end. Absence must not be read into it.
    const t = await late({ end: "none", opens: () => false }, (env) => {
      env.serviceStore.subscribe(() => {
        if (viewed !== null && env.serviceStore.get() === viewed) dead = true;
      });
    });
    const original = t.runtime.open.bind(t.runtime);
    t.runtime.open = async (account, options) => {
      const result = await original(account, options);
      if (result.kind !== "opened" || viewed !== null) return result;
      const service = result.service;
      viewed = new Proxy(service, {
        get: (target, key) =>
          key === "live"
            ? !dead && target.live
            : Reflect.get(target, key, target),
      });
      return { ...result, service: viewed };
    };
    try {
      await t.settle();
      expect(dead).toBe(true);
      expect(t.published.map((p) => p.service)).toContain(viewed);
      expect(t.env.service()).toBeNull();
      await t.advance(65_000);
      expect({ profile: t.profile(), device: t.device() }).toEqual({
        profile: 0,
        device: 0,
      });
      expect(t.opens.length).toBe(1);
      t.hint();
      await t.settle();
      expect(t.opens.length).toBe(2);
      expect(live(t)).toBe(true);
      expect(t.env.service()).not.toBe(viewed);
      await t.advance(65_000);
      expect({ profile: t.profile(), device: t.device() }).toEqual({
        profile: 0,
        device: 0,
      });
      expect(durable(t)).toEqual({ "profile:1": PAUSE, "device:1": PAUSE });
    } finally {
      t.close();
    }
  });
});

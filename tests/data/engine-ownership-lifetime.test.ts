// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { nextDelay } from "../../src/data/model/retry";
import { type AccountStore, StoreFailure } from "../../src/data/store/port";
import { StampedRequestError } from "../../src/session";
import { engineWorld } from "../support/data/engine-world";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";

/**
 * R26 and R27 (revision 12): the ownership seam of both controllers, and the eligibility of a sync step at the moment it issues.
 *
 * R26: every `start` added an abort listener that closed over the controller's SHARED timer and waiters and was removed by nothing, so
 * after `start(A)` then `start(B)` (with a `stop()` between or not), aborting A cleared B's schedule: the sync engine never made the
 * request at its idle deadline, the dispatcher never retried at its `Retry-After`, until some unrelated wake. A signal's cleanup now
 * belongs to the run that installed it: removed when that run ends, and bound to its generation besides.
 *
 * R27: the last `alive` test of a sync step preceded `await quota.check(...)`, and what followed (`running`, the request) assumed
 * nothing had changed: a `stop()`, an aborted ownership, offline, a disposed service and a moved identity during that await still
 * issued a request, and `running` overwrote the `not_started` that `stop()` had published. The eligibility is judged again, in the
 * synchronous step that issues. The same family, assessed: the capture await, the failed request, the unread error body.
 *
 * The production engine and dispatcher over the double of IndexedDB, with fake time and a scripted network. FIXTURE evidence.
 */

// ---- helpers ---------------------------------------------------------------------------------------------------------------------
/** What an `AbortSignal` has been given to listen with and has not been told to forget. */
function ledger(signal: AbortSignal): { live(): number; added(): number } {
  const live = new Set<unknown>();
  let added = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "abort") {
      live.add(listener);
      added += 1;
    }
    return add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === "abort") live.delete(listener);
    return remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  return { live: () => live.size, added: () => added };
}

/** Holds the next run of the named plan, as a slow transaction would; `release` runs it, `fail` rejects it. */
function holdPlan(store: AccountStore, name: string) {
  const real = store.run.bind(store);
  let armed = true;
  let release: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  (store as { run: AccountStore["run"] }).run = ((
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    if (armed && plan.name === name) {
      armed = false;
      return new Promise<unknown>((resolve, reject) => {
        release = () => {
          void (real as (...args: unknown[]) => Promise<unknown>)(
            plan,
            input,
            options,
          ).then(resolve, reject);
        };
        fail = reject;
      });
    }
    return (real as (...args: unknown[]) => Promise<unknown>)(
      plan,
      input,
      options,
    );
  }) as AccountStore["run"];
  return {
    held: () => !armed,
    release: () => release(),
    fail: (error: unknown) => fail(error),
  };
}

type EngineWorld = Awaited<ReturnType<typeof engineWorld>>;
type OutboxWorld = Awaited<ReturnType<typeof outboxWorld>>;
/** The engine's own idle poll: production timing, in fake time. */
const IDLE = DATA_CONFIG.syncIdleMs;
const own = (signal: AbortSignal) => ({ token: null, signal });
const kind = (w: EngineWorld): string => w.state().kind;

// ---- R26: the sync engine ----------------------------------------------------------------------------------------------------------
describe("R26, sync engine: an obsolete ownership signal never ends the current run's schedule", () => {
  for (const between of ["a restart", "a stop and a start"] as const)
    for (const abort of [
      "no one",
      "the old signal",
      "the current signal",
    ] as const)
      test(`${between}, then ${abort} aborts: the idle deadline ${abort === "the current signal" ? "is cancelled (the owner is gone)" : "still brings the next request"}`, async () => {
        const w = await engineWorld();
        const a = new AbortController();
        const b = new AbortController();
        w.engine.start(own(a.signal));
        await w.settle();
        expect(w.requests).toHaveLength(1);
        if (between === "a stop and a start") w.engine.stop();
        w.engine.start(own(b.signal));
        await w.settle();
        expect(w.requests).toHaveLength(2);
        if (abort === "the old signal") a.abort();
        if (abort === "the current signal") b.abort();
        await w.advance(IDLE);
        expect(w.requests).toHaveLength(abort === "the current signal" ? 2 : 3);
        // The deadline after that one is kept too, and the legitimate abort still ends the run for good.
        if (abort !== "the current signal") {
          await w.advance(IDLE);
          expect(w.requests).toHaveLength(4);
          b.abort();
          await w.advance(IDLE * 5);
          expect(w.requests).toHaveLength(4);
        }
        w.engine.stop();
      });

  test("an abort of the old signal after it was replaced, with the old signal already stopped, touches nothing", async () => {
    const w = await engineWorld();
    const a = new AbortController();
    const b = new AbortController();
    w.engine.start(own(a.signal));
    await w.settle();
    w.engine.stop();
    w.engine.start(own(b.signal));
    await w.settle();
    expect(w.requests).toHaveLength(2);
    a.abort();
    a.abort();
    await w.advance(IDLE);
    expect(w.requests).toHaveLength(3);
    w.engine.stop();
  });

  test("the same signal, started again (restart or stop and start), holds ONE listener, and its abort ends the standing run", async () => {
    const w = await engineWorld();
    const a = new AbortController();
    const seen = ledger(a.signal);
    w.engine.start(own(a.signal));
    for (let i = 0; i < 6; i += 1) {
      if (i % 2 === 1) w.engine.stop();
      w.engine.start(own(a.signal));
    }
    await w.settle();
    expect(seen.live()).toBe(1);
    expect(seen.added()).toBe(7);
    w.engine.stop();
    expect(seen.live()).toBe(0);
    w.engine.start(own(a.signal));
    await w.settle();
    expect(seen.live()).toBe(1);
    const before = w.requests.length;
    a.abort();
    await w.advance(IDLE * 5);
    expect(w.requests).toHaveLength(before);
  });

  test("a signal that is already aborted when it is handed over ends nothing that stands and starts nothing", async () => {
    const w = await engineWorld();
    const live = new AbortController();
    w.engine.start(own(live.signal));
    await w.settle();
    expect(w.requests).toHaveLength(1);
    const dead = new AbortController();
    dead.abort();
    w.engine.start(own(dead.signal));
    await w.advance(IDLE * 5);
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a restart while a request is outstanding: the old signal's late abort does not end the new run's timer or release its waiters", async () => {
    const w = await engineWorld();
    const a = new AbortController();
    const b = new AbortController();
    let release!: (response: Response) => void;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    w.engine.start(own(a.signal));
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
    w.engine.start(own(b.signal));
    await w.settle();
    // The new generation's first tick is coalesced into the old step, which is still waiting for its response.
    expect(w.requests).toHaveLength(1);
    let released = false;
    void w.engine.settled().then(() => {
      released = true;
    });
    a.abort();
    await w.settle();
    expect(released).toBe(false);
    release(w.emptyPage("cursor-late"));
    await w.settle();
    // The old step unwound and handed over: the new run asked once, and its idle poll stands.
    expect(w.requests).toHaveLength(2);
    a.abort();
    await w.advance(IDLE);
    expect(w.requests).toHaveLength(3);
    w.engine.stop();
  });
});

// ---- R26: the dispatcher -----------------------------------------------------------------------------------------------------------
describe("R26, dispatcher: an obsolete ownership signal never ends the current run's retry deadline", () => {
  const enqueue = (w: OutboxWorld) =>
    w.outbox.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { kind: "create" } }),
    });

  for (const between of ["a restart", "a stop and a start"] as const)
    for (const abort of [
      "no one",
      "the old signal",
      "the current signal",
    ] as const)
      test(`${between}, then ${abort} aborts: the 10 s Retry-After ${abort === "the current signal" ? "is not retried (the owner is gone)" : "is retried at its deadline"}`, async () => {
        const w = await outboxWorld();
        const a = new AbortController();
        const b = new AbortController();
        w.dispatcher.start(own(a.signal));
        await w.settle();
        if (between === "a stop and a start") w.dispatcher.stop();
        w.dispatcher.start(own(b.signal));
        await w.settle();
        w.script.push(
          w.error(503, "temporarily_unavailable", { "retry-after": "10" }),
        );
        await enqueue(w);
        await w.settle();
        expect(w.sent).toHaveLength(1);
        if (abort === "the old signal") a.abort();
        if (abort === "the current signal") b.abort();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(abort === "the current signal" ? 1 : 2);
        w.dispatcher.stop();
      });

  test("the same signal, started again, holds ONE listener, and its abort ends the standing run", async () => {
    const w = await outboxWorld();
    const a = new AbortController();
    const seen = ledger(a.signal);
    w.dispatcher.start(own(a.signal));
    for (let i = 0; i < 6; i += 1) {
      if (i % 2 === 1) w.dispatcher.stop();
      w.dispatcher.start(own(a.signal));
    }
    await w.settle();
    expect(seen.live()).toBe(1);
    w.dispatcher.stop();
    expect(seen.live()).toBe(0);
    w.dispatcher.start(own(a.signal));
    expect(seen.live()).toBe(1);
    a.abort();
    w.script.push(
      w.error(503, "temporarily_unavailable", { "retry-after": "10" }),
    );
    await enqueue(w);
    await w.advance(20_000);
    // The run is over: nothing is sent by a dispatcher whose owner is gone.
    expect(w.sent).toHaveLength(0);
  });

  test("a restart while a request is outstanding: the old signal's late abort changes nothing, and the new run's retry deadline stands", async () => {
    const w = await outboxWorld();
    const a = new AbortController();
    const b = new AbortController();
    let release!: (response: Response) => void;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    w.dispatcher.start(own(a.signal));
    await w.settle();
    await enqueue(w);
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
    w.dispatcher.start(own(b.signal));
    await w.settle();
    a.abort();
    // The old run's answer is dropped (its run ended); the new run resends the same draft, and a 503 makes it wait 10 s.
    w.script.push(
      w.error(503, "temporarily_unavailable", { "retry-after": "10" }),
    );
    release(w.receipt());
    await w.settle();
    const afterHandover = w.sent.length;
    a.abort();
    await w.advance(10_000);
    expect(w.sent.length).toBeGreaterThan(afterHandover);
    w.dispatcher.stop();
  });
});

// ---- R27: a sync step issues only while it is still eligible ---------------------------------------------------------------
describe("R27, sync engine: eligibility is judged again where the request is issued", () => {
  /** Holds the FIRST quota check (a step's) and lets every later one through. */
  function holdQuota(w: EngineWorld, verdict: "ok" | "refuse" = "ok") {
    const real = w.quota.check.bind(w.quota);
    let armed = true;
    let resolve: (value: "ok" | "refuse") => void = () => undefined;
    w.quota.check = ((...args: Parameters<typeof real>) => {
      if (!armed) return real(...args);
      armed = false;
      return new Promise<"ok" | "refuse" | "unknown">((r) => {
        resolve = r;
      });
    }) as typeof w.quota.check;
    return {
      held: () => !armed,
      release: () => resolve(verdict),
    };
  }

  const CHANGES = {
    stop: (w: EngineWorld) => w.engine.stop(),
    "the ownership aborted": (w: EngineWorld) => w.ownership.abort(),
    "going offline": (w: EngineWorld) => {
      w.online = false;
    },
    "the service disposed": (w: EngineWorld) => w.service.dispose("closed"),
    "the identity leaving the account": (w: EngineWorld) =>
      w.identity.move({ account: null, epoch: 2 }),
  } as const;

  for (const verdict of ["ok", "refuse"] as const)
    for (const [name, change] of Object.entries(CHANGES))
      test(`${name} during the quota read (verdict ${verdict}): no request and no state of a step that has no right to one`, async () => {
        const w = await engineWorld();
        const quota = holdQuota(w, verdict);
        w.start();
        await w.settle();
        expect(quota.held()).toBe(true);
        expect(w.requests).toHaveLength(0);
        change(w);
        quota.release();
        await w.settle();
        expect(w.requests).toHaveLength(0);
        // Neither the request's `running` nor the quota's `storage_full` is published by a step that was no longer eligible.
        expect(kind(w)).not.toBe("running");
        expect(w.state()).not.toMatchObject({ cause: "storage_full" });
        if (name === "stop") expect(w.state()).toEqual({ kind: "not_started" });
        if (name === "going offline")
          expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
        // The runtime follows the identity: when it leaves the account the service is disposed, so the step that evaluates again
        // finds no live service (the engine's word for that is `cache_not_valid`), not an identity that differs from a live one.
        if (name === "the identity leaving the account")
          expect(w.state()).toEqual({
            kind: "waiting",
            reason: "cache_not_valid",
          });
        if (name === "the service disposed")
          expect(w.state()).toEqual({
            kind: "waiting",
            reason: "cache_not_valid",
          });
        w.engine.stop();
      });

  test("control: nothing changes during the quota read, and the request is issued once", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(kind(w)).toBe("idle");
    w.engine.stop();
  });

  test("control: a quota refusal with nothing changed is still the storage-full stop", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w, "refuse");
    w.start();
    await w.settle();
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "stopped", cause: "storage_full" });
    w.engine.stop();
  });

  test("control: connectivity that went and came back during the read leaves the step eligible", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    w.online = false;
    w.online = true;
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("the identity moves to a new epoch of the same account during the read: the step is evaluated again and asks once, under the new epoch", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(kind(w)).toBe("idle");
    // Two captures: the one the step abandoned, and the one it made again under the new epoch.
    expect(w.sync().request_seq).toBe(2);
    w.engine.stop();
  });

  test("offline during the read, then online again later: the request follows the connectivity, once", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    w.online = false;
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
    w.goOnline();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a restart during the read: the old step issues nothing, and the new run asks exactly once", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    expect(quota.held()).toBe(true);
    w.engine.stop();
    w.start();
    await w.settle();
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    expect(kind(w)).toBe("idle");
    w.engine.stop();
  });

  test("every step after a run ended finds its own world: the next start asks again", async () => {
    const w = await engineWorld();
    const quota = holdQuota(w);
    w.start();
    await w.settle();
    w.engine.stop();
    quota.release();
    await w.settle();
    expect(w.requests).toHaveLength(0);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });
});

describe("R27, the same family: the other awaits of a step publish nothing into a run that is not the one that stands", () => {
  test("the capture read: a gated answer that arrives after stop() leaves not_started in place", async () => {
    // An invalid cache: the capture answers `gated`, which publishes `waiting / cache_not_valid` when the run still stands.
    const w = await engineWorld();
    w.setSync({ cache_status: "invalid" });
    const held = holdPlan(w.service.store, "data.captureRequest");
    w.start();
    await w.settle();
    expect(held.held()).toBe(true);
    w.engine.stop();
    held.release();
    await w.settle();
    expect(w.state()).toEqual({ kind: "not_started" });
    expect(w.requests).toHaveLength(0);
  });

  test("control: the same gated answer, with the run standing, publishes it", async () => {
    const w = await engineWorld();
    w.setSync({ cache_status: "invalid" });
    const held = holdPlan(w.service.store, "data.captureRequest");
    w.start();
    await w.settle();
    held.release();
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    w.engine.stop();
  });

  for (const failure of [
    ["a closed store", () => new StoreFailure("closed")],
    ["an ordinary failure", () => new Error("the capture transaction failed")],
  ] as const)
    test(`the capture read failing after stop() (${failure[0]}): the failure is not published or counted into the stopped run`, async () => {
      const w = await engineWorld();
      const held = holdPlan(w.service.store, "data.captureRequest");
      w.start();
      await w.settle();
      expect(held.held()).toBe(true);
      w.engine.stop();
      held.fail(failure[1]());
      await w.settle();
      expect(w.state()).toEqual({ kind: "not_started" });
      expect(w.requests).toHaveLength(0);
    });

  test("control: a closed store on the capture read, with the run standing, is the session pause", async () => {
    const w = await engineWorld();
    const held = holdPlan(w.service.store, "data.captureRequest");
    w.start();
    await w.settle();
    held.fail(new StoreFailure("closed"));
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    w.engine.stop();
  });

  test("an unsent request of a run that ended does not advance the NEXT run's quiet back-off: its first refusal waits the first step", async () => {
    const w = await engineWorld();
    let reject!: (error: unknown) => void;
    w.script.push(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    // The new run's own first request is refused as unsent too.
    w.script.push(new StampedRequestError("not_sent"));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
    w.start();
    reject(new StampedRequestError("not_sent"));
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.state()).not.toMatchObject({
      kind: "waiting",
      reason: "paused_by_session",
    });
    // The first quiet step (50 ms), not the second (100 ms) that the ended run's refusal would have left it at.
    await w.advance(DATA_CONFIG.notSentBackoffMs[0]);
    expect(w.requests).toHaveLength(3);
    w.engine.stop();
  });

  test("a request that is refused after stop() (stamped not_covered) leaves not_started in place", async () => {
    const w = await engineWorld();
    let reject!: (error: unknown) => void;
    w.script.push(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
    reject(new StampedRequestError("not_covered"));
    await w.advance(60_000);
    expect(w.state()).toEqual({ kind: "not_started" });
    expect(w.requests).toHaveLength(1);
  });

  test("a network failure after stop() is no failure of the next run: it starts with a clean count and a first back-off", async () => {
    const w = await engineWorld();
    let reject!: (error: unknown) => void;
    w.script.push(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    w.start();
    await w.settle();
    w.engine.stop();
    reject(new TypeError("network down"));
    await w.settle();
    expect(w.state()).toEqual({ kind: "not_started" });
    w.start();
    await w.settle();
    expect(kind(w)).toBe("idle");
    w.engine.stop();
  });

  test("a stale `online` continuation (its run ended while the resume was outstanding) does not reset the NEW run's failure count", async () => {
    const w = await engineWorld();
    const times: number[] = [];
    const failing = () => {
      times.push(w.env.world.time);
      return w.status(503);
    };
    for (let i = 0; i < 8; i += 1) w.script.push(failing);
    const held = holdPlan(w.service.store, "data.resumeReadCallerOnOnline");
    w.start();
    await w.settle();
    expect(times).toHaveLength(1);
    // The browser comes back online: the resume of the read caller is outstanding when the run is replaced.
    w.goOnline();
    await w.settle();
    expect(held.held()).toBe(true);
    w.engine.stop();
    w.start();
    await w.settle();
    expect(times).toHaveLength(2);
    held.release();
    await w.settle();
    const first = nextDelay(1, 0.5, DATA_CONFIG);
    const second = nextDelay(2, 0.5, DATA_CONFIG);
    expect(second).toBeGreaterThan(first);
    // The new run failed once (count 1): its next wait is the first step, and the one after it the SECOND. A continuation of the ended
    // run that had reset the count would make that wait the first step again.
    await w.advance(first);
    expect(times).toHaveLength(3);
    await w.advance(first);
    expect(times).toHaveLength(3);
    await w.advance(second - first);
    expect(times).toHaveLength(4);
    w.engine.stop();
  });

  test("an unread 503 body when the run ends: device_capacity is not published into the stopped run", async () => {
    const w = await engineWorld();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ code: "device_capacity" }),
            ),
          );
          controller.close();
        };
      },
    });
    w.script.push(
      new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
    finish();
    await w.settle();
    expect(w.state()).toEqual({ kind: "not_started" });
  });

  test("control: the same 503 body with the run standing is the blocking capacity stop", async () => {
    const w = await engineWorld();
    w.script.push(w.status(503, { body: { code: "device_capacity" } }));
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "device_capacity" });
    w.engine.stop();
  });
});

// ---- R27 parity: the dispatcher's stale continuations ---------------------------------------------------------------------------
describe("R27, dispatcher: a stale continuation publishes and counts nothing into a run that is not the one that stands", () => {
  const state = (w: OutboxWorld): string => w.dispatcher.state.get().kind;
  const enqueue = (w: OutboxWorld) =>
    w.outbox.enqueue({
      endpoint: "/commands",
      targets: [],
      build: () => ({ command: { kind: "create" } }),
    });

  for (const failure of [
    ["a closed store", () => new StoreFailure("closed")],
    ["an ordinary failure", () => new Error("the queue read failed")],
  ] as const)
    test(`the queue read failing after stop() (${failure[0]}) leaves not_started in place`, async () => {
      const w = await outboxWorld();
      const held = holdPlan(w.service.store, "data.readDispatchWindow");
      w.start();
      await w.settle();
      expect(held.held()).toBe(true);
      w.dispatcher.stop();
      held.fail(failure[1]());
      await w.settle();
      expect(w.dispatcher.state.get()).toEqual({ kind: "not_started" });
    });

  test("an unsent request of a run that ended does not advance the NEXT run's quiet back-off: its first refusal waits the first step", async () => {
    const w = await outboxWorld();
    let reject!: (error: unknown) => void;
    w.script.push(
      () =>
        new Promise<never>((_, r) => {
          reject = r;
        }),
    );
    w.script.push(new StampedRequestError("not_sent"));
    w.start();
    await w.settle();
    await enqueue(w);
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
    w.start();
    reject(new StampedRequestError("not_sent"));
    await w.settle();
    expect(w.sent).toHaveLength(2);
    await w.advance(DATA_CONFIG.notSentBackoffMs[0]);
    expect(w.sent).toHaveLength(3);
    w.dispatcher.stop();
  });

  for (const refusal of ["not_sent", "not_covered", "closed", "stale"] as const)
    test(`a request refused as ${refusal} after stop(): the draft is back in the queue, and not_started stays`, async () => {
      const w = await outboxWorld();
      let reject!: (error: unknown) => void;
      w.script.push(
        () =>
          new Promise<never>((_, r) => {
            reject = r;
          }),
      );
      w.start();
      await w.settle();
      await enqueue(w);
      await w.settle();
      expect(w.sent).toHaveLength(1);
      w.dispatcher.stop();
      reject(new StampedRequestError(refusal));
      await w.advance(60_000);
      expect(state(w)).toBe("not_started");
      // Durable cleanup is the run's whatever happens to its state: a refusal that sent nothing hands the draft back, and a stale one
      // leaves it where it was for the record to be read again.
      const status = w.drafts()[0]?.status;
      expect(status).toBe(refusal === "stale" ? "in_flight" : "queued");
      expect(w.sent).toHaveLength(1);
    });

  test("control: the same refusal with the run standing publishes the session state", async () => {
    const w = await outboxWorld();
    w.script.push(new StampedRequestError("closed"));
    w.start();
    await w.settle();
    await enqueue(w);
    await w.settle();
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "session",
    });
    w.dispatcher.stop();
  });
});

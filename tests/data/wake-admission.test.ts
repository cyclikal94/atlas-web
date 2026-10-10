// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { nextDelay } from "../../src/data/model/retry";
import { engineWorld } from "../support/data/engine-world";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";

/**
 * R23 (revision 11): an ORDINARY wake does not end a retry deadline or a blocking stop. The engine used to start a step on every
 * notification and every immediate nudge whatever it was waiting for, and a receipt nudge replaced the timer that held a back-off:
 * five notifications after a `Retry-After: 60` answer made six requests inside 1.25 simulated seconds, a receipt asked again within
 * 4.25 seconds, and a `503 device_capacity` (blocking, no automatic retry) was asked again by a notification, a nudge or a receipt
 * with no explicit retry. The revision-10 pending-wake rule protected a step's schedule only while the step was BUSY.
 *
 * The rule (`admitted` in `sync-engine.ts`): a back-off (its deadline is the timer the step set) and the blocking capacity stop
 * are HELD conditions of the service they were decided under. A notification (`wake`) and a nudge (`nudge`, the receipt's too) neither
 * start a step nor move the timer while one is held. The ways out are the deadline, the person's "Retry now", and `online` (a back-off
 * only: it is one of the two acts that end one, and costs one request each). A held condition belongs to ONE service: when the service
 * ends or is replaced the next wake evaluates again. Every other pause and stop is held by the durable record or the capture gate,
 * which each step reads again, so they are not held here. An idle (healthy) engine still follows a notification, as before.
 *
 * Both sides of a step's completion are covered: the wakes arrive while the failing request is outstanding (the busy path, R22) and
 * after the step settled (the idle path). The production engine, plans and guards over the double of IndexedDB, with fake time and a
 * scripted network. FIXTURE evidence.
 */
type World = Awaited<ReturnType<typeof engineWorld>>;

const RETRY_AFTER_MS = 60_000;
type Cause = number | "network";
const CAUSES: Cause[] = [500, 502, 504, 429, "network"];

/** The times (world ms) at which the engine asked, and a failing answer for `cause` for as many requests as are scripted. */
function failing(w: World, cause: Cause, count = 12): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i += 1)
    w.script.push(() => {
      times.push(w.env.world.time);
      return cause === "network"
        ? new TypeError("network down")
        : w.status(cause, { headers: { "retry-after": "60" } });
    });
  return times;
}

const ORDINARY = [
  ["a notification", (w: World) => w.fire()],
  ["an immediate nudge", (w: World) => w.engine.nudge("now")],
  ["a receipt nudge", (w: World) => w.engine.nudge("receipt")],
] as const;

describe("a back-off's deadline stands against every ordinary wake", () => {
  // The deadline: the server's `Retry-After` (60 s, the cap), or the schedule's first step for a network error (jitter at its middle).
  const deadlineOf = (cause: Cause): number =>
    cause === "network" ? nextDelay(1, 0.5, DATA_CONFIG) : RETRY_AFTER_MS;

  for (const cause of CAUSES)
    for (const [name, wake] of ORDINARY)
      test(`${cause}, then ${name} four times inside the wait: one request, the back-off shown, and the next one at the deadline and no sooner`, async () => {
        const w = await engineWorld();
        const times = failing(w, cause);
        w.start();
        await w.settle();
        expect(times).toHaveLength(1);
        expect(w.state().kind).toBe("backing_off");
        const deadline = deadlineOf(cause);
        const step = Math.floor(deadline / 5);
        for (let i = 0; i < 4; i += 1) {
          wake(w);
          await w.settle();
          await w.advance(step);
        }
        expect(times).toHaveLength(1);
        expect(w.state().kind).toBe("backing_off");
        // Nothing came earlier; the deadline comes (one request, a little after the deadline's timer).
        await w.advance(deadline - 4 * step + 1_000);
        expect(times).toHaveLength(2);
        const gap = (times[1] as number) - (times[0] as number);
        expect(gap).toBeGreaterThanOrEqual(deadline);
        expect(gap).toBeLessThan(deadline + 2_000);
        w.engine.stop();
      });

  for (const [name, wake] of ORDINARY)
    test(`${name} while the failing request is still outstanding, and again after it settled: one request until the deadline (both sides of the step)`, async () => {
      const w = await engineWorld();
      const times: number[] = [];
      let release: (answer: Response) => void = () => undefined;
      w.script.push(
        () =>
          new Promise<Response>((resolve) => {
            times.push(w.env.world.time);
            release = resolve;
          }),
      );
      w.start();
      await w.settle();
      expect(times).toHaveLength(1);
      // During the step: remembered (R22) and judged when it ends. The step ends in a back-off, whose deadline stands.
      for (let i = 0; i < 5; i += 1) wake(w);
      await w.settle();
      release(w.status(503, { headers: { "retry-after": "60" } }));
      await w.settle();
      expect(w.state().kind).toBe("backing_off");
      expect(times).toHaveLength(1);
      // After it settled: dropped.
      for (let i = 0; i < 5; i += 1) {
        wake(w);
        await w.settle();
        await w.advance(1_000);
      }
      expect(times).toHaveLength(1);
      w.engine.stop();
    });

  test("120 wakes of every kind while the failing request is outstanding: one request in flight, one request in all, and the back-off stands afterwards", async () => {
    const w = await engineWorld();
    let release: (answer: Response) => void = () => undefined;
    let inFlight = 0;
    let peak = 0;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          release = (answer) => {
            inFlight -= 1;
            resolve(answer);
          };
        }),
    );
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) {
      w.fire();
      w.engine.nudge("now");
      w.engine.nudge("receipt");
      if (i % 10 === 0) await w.settle();
    }
    await w.settle();
    expect(w.requests).toHaveLength(1);
    release(w.status(503, { headers: { "retry-after": "60" } }));
    await w.settle();
    await w.advance(30_000);
    expect(w.requests).toHaveLength(1);
    expect(peak).toBe(1);
    expect(w.state().kind).toBe("backing_off");
    w.engine.stop();
  });

  test("a late epoch (the sign-in moves while a back-off stands): the wake is dropped, and the step at the deadline asks under the new one", async () => {
    const w = await engineWorld();
    const times = failing(w, 503);
    w.start();
    await w.settle();
    expect(times).toHaveLength(1);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    await w.settle();
    await w.advance(20_000);
    expect(times).toHaveLength(1);
    await w.advance(RETRY_AFTER_MS);
    expect(times).toHaveLength(2);
    w.engine.stop();
  });

  test("a held back-off belongs to its service: when the service ends, the next wake evaluates again (it holds nothing for a database that is gone)", async () => {
    const w = await engineWorld();
    const times = failing(w, 503);
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("backing_off");
    w.service.dispose("closed");
    w.fire();
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    expect(times).toHaveLength(1);
    w.engine.stop();
  });
});

describe("the ways out of a back-off still work, and cost one request each", () => {
  test("quiet: the deadline sends exactly one request", async () => {
    const w = await engineWorld();
    const times = failing(w, 503);
    w.start();
    await w.settle();
    await w.advance(RETRY_AFTER_MS + 2_000);
    expect(times).toHaveLength(2);
    w.engine.stop();
  });

  test("`online`: one request at once, not at the deadline, and a second `online` is a second request", async () => {
    const w = await engineWorld();
    const times = failing(w, 503);
    w.start();
    await w.settle();
    const first = w.env.world.time;
    w.goOnline();
    await w.settle();
    expect(times).toHaveLength(2);
    expect((times[1] as number) - first).toBeLessThan(5_000);
    // Wakes beside it (the listeners `goOnline` also fires) did not make more.
    await w.advance(10_000);
    expect(times).toHaveLength(2);
    w.engine.stop();
  });

  test("the person's `Retry now`: one request at once", async () => {
    const w = await engineWorld();
    const times = failing(w, 503);
    w.start();
    await w.settle();
    w.engine.retryNow();
    await w.settle();
    expect(times).toHaveLength(2);
    await w.advance(10_000);
    expect(times).toHaveLength(2);
    w.engine.stop();
  });

  test("a sustained outage that ends in a pause is left by `online` and by `Retry now` as before", async () => {
    const w = await engineWorld();
    failing(w, 503, 40);
    w.start();
    await w.settle();
    await w.advance(10 * 60_000);
    expect(w.state().kind).toBe("paused");
    const before = w.requests.length;
    w.fire();
    w.engine.nudge("now");
    w.engine.nudge("receipt");
    await w.advance(120_000);
    expect(w.requests.length).toBe(before);
    w.goOnline();
    await w.settle();
    expect(w.requests.length).toBe(before + 1);
    w.engine.stop();
  });
});

describe("the blocking capacity stop is left only by the person", () => {
  const stopped = async () => {
    const w = await engineWorld();
    for (let i = 0; i < 8; i += 1)
      w.script.push(w.status(503, { body: { code: "device_capacity" } }));
    w.start();
    await w.settle();
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "device_capacity",
    });
    expect(w.requests).toHaveLength(1);
    return w;
  };

  for (const [name, wake] of [
    ...ORDINARY,
    ["`online` (the event and the listeners)", (w: World) => w.goOnline()],
  ] as const)
    test(`${name}, repeatedly over ten minutes: still one request, still stopped`, async () => {
      const w = await stopped();
      for (let i = 0; i < 10; i += 1) {
        wake(w);
        await w.settle();
        await w.advance(60_000);
      }
      expect(w.requests).toHaveLength(1);
      expect(w.state()).toMatchObject({
        kind: "stopped",
        cause: "device_capacity",
      });
      w.engine.stop();
    });

  test("wakes that arrive while the capacity answer is still being read do not leave the stop either (the busy side)", async () => {
    const w = await engineWorld();
    let release: (answer: Response) => void = () => undefined;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    w.start();
    await w.settle();
    for (let i = 0; i < 5; i += 1) {
      w.fire();
      w.engine.nudge("now");
      w.engine.nudge("receipt");
    }
    release(w.status(503, { body: { code: "device_capacity" } }));
    await w.settle();
    await w.advance(60_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toMatchObject({
      kind: "stopped",
      cause: "device_capacity",
    });
    w.engine.stop();
  });

  test("`Retry now` leaves it: one request, and the engine goes on (a healthy answer is idle); a second capacity answer stops it again, once", async () => {
    const again = await stopped();
    again.engine.retryNow();
    await again.settle();
    await again.advance(60_000);
    expect(again.requests).toHaveLength(2);
    expect(again.state()).toMatchObject({
      kind: "stopped",
      cause: "device_capacity",
    });
    again.engine.stop();

    const w = await stopped();
    // The person retired a device: the server now answers.
    w.script.length = 0;
    w.engine.retryNow();
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.state().kind).not.toBe("stopped");
    w.engine.stop();
  });

  test("a capacity stop belongs to its service: a service that ended holds nothing", async () => {
    const w = await stopped();
    w.service.dispose("closed");
    w.fire();
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });
});

describe("what is NOT held: the rule is no wider than the reviewer's finding", () => {
  test("a healthy idle engine still follows a notification, and a receipt shortens its wait", async () => {
    const w = await engineWorld();
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("idle");
    const first = w.requests.length;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBe(first + 1);
    w.engine.nudge("receipt");
    await w.advance(5_000);
    expect(w.requests.length).toBe(first + 2);
    w.engine.stop();
  });

  test("a durable pause (by duration, or by three unrecognised answers) stays paused under ordinary wakes: no request", async () => {
    for (const pause of ["duration", "unrecognised"] as const) {
      const w = await engineWorld();
      w.setSync({
        read_retry_states: {
          sync: {
            paused: true,
            backing_off_since: pause === "duration" ? 1 : null,
            unrecognised_streak: pause === "unrecognised" ? 3 : 0,
          },
        },
      });
      w.start();
      await w.settle();
      w.fire();
      w.engine.nudge("now");
      w.engine.nudge("receipt");
      await w.advance(4_000);
      expect(w.requests).toHaveLength(0);
      w.engine.stop();
    }
  });

  test("while offline a notification still reaches the engine (it is waiting, not backing off)", async () => {
    const w = await engineWorld();
    w.online = false;
    w.start();
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
    w.online = true;
    w.fire();
    await w.settle();
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
    w.engine.stop();
  });
});

describe("the dispatcher: a draft's own deadline already stood against every wake (controls, unchanged by R23)", () => {
  // The dispatcher's eligibility is per draft (`blockedUntil`, the durable retry state), so a re-evaluation cannot send early what a
  // back-off holds. These are the review's controls, kept so that a change to either engine's admission cannot lose it.
  for (const status of [500, 429])
    for (const trigger of [
      "quiet",
      "notify",
      "wake",
      "retry",
      "online",
    ] as const)
      test(`${status}, ${trigger}: ${trigger === "retry" || trigger === "online" ? "one request more, at once" : "one request, until the deadline"}`, async () => {
        const w = await outboxWorld();
        const queued = await w.outbox.enqueue({
          localId: "one",
          endpoint: "/commands",
          targets: [
            {
              resourceId: "person",
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          build: () => ({
            command: {
              kind: "create_person",
              id: "person",
              expected_version: 1,
            },
          }),
        });
        expect(queued.kind).toBe("queued");
        for (let i = 0; i < 8; i += 1)
          w.script.push(
            w.error(status, "unavailable", { "retry-after": "60" }),
          );
        w.start();
        await w.settle();
        expect(w.sent.length).toBe(1);
        for (let i = 0; i < 5; i += 1) {
          if (trigger === "notify") w.fire();
          if (trigger === "wake") w.dispatcher.wake();
          if (trigger === "retry" && i === 0) w.outbox.retry();
          if (trigger === "online" && i === 0) w.goOnline();
          await w.settle();
          await w.advance(250);
        }
        const requests = w.sent.length;
        w.dispatcher.stop();
        expect(requests).toBe(
          trigger === "retry" || trigger === "online" ? 2 : 1,
        );
      });
});

// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createPendingWake } from "../../src/data/engine/pending-wake";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import { StampedRequestError } from "../../src/session";
import { engineWorld } from "../support/data/engine-world";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";
import { cacheRow, draftRow } from "../support/data/rows";

/**
 * R22 (revision 10): a wake that arrives while a step runs is not lost. Both engines run ONE step at a time, and a step reads its facts
 * (the service, the identity, connectivity, the queue) before it waits for a response or a commit. A wake that arrives after that read
 * is news the step does not have; the engine used to drop it, and a step that then ended with nothing scheduled slept until the next
 * event, so the draft that was saved at that moment, or the identity that moved, waited for good (the review's two schedules: an
 * enqueue during an empty queue read, and an epoch change during a page's decode; each ended with zero further requests after an
 * hour).
 *
 * The rule (`pending-wake.ts`, applied by `settle` in each engine) is narrower than the revision-8 loop that this replaced, which
 * re-ran the step whatever it had decided and so skipped a back-off:
 *
 *  - the wake is REMEMBERED; when the step ends the engine evaluates again only where the step left nothing scheduled (the sync engine),
 *    or always, because eligibility is per draft (the dispatcher);
 *  - a notification counts only if what a step reads has changed since it last looked (a republished identity is not news and cannot
 *    feed itself), an explicit act (work saved, `online`, "Retry now", a receipt) counts every time;
 *  - a back-off, an idle poll and a paced retry are deadlines and STAND; one request is in flight; one request per `online`.
 *
 * Production composition: the production engine and dispatcher, plans and guards over the double of IndexedDB, with fake time. The
 * network is a script. FIXTURE evidence: nothing here is a backend.
 */

describe("the latch (pure)", () => {
  test("an explicit signal during a step is remembered, once, and forgotten by taking it", () => {
    const wakes = createPendingWake();
    wakes.begin("a");
    expect(wakes.take()).toBe(false);
    wakes.signal();
    wakes.signal();
    expect(wakes.take()).toBe(true);
    expect(wakes.take()).toBe(false);
  });

  test("a notification counts only when what a step reads is different from what was last seen", () => {
    const wakes = createPendingWake();
    wakes.begin("a");
    wakes.notify("a");
    wakes.notify("a");
    expect(wakes.take()).toBe(false);
    wakes.begin("a");
    wakes.notify("b");
    expect(wakes.take()).toBe(true);
  });

  test("a change and its reversal during one step are both news: the step may have read either", () => {
    const wakes = createPendingWake();
    wakes.begin("a");
    wakes.notify("b");
    wakes.notify("a");
    expect(wakes.take()).toBe(true);
  });

  test("each step begins clean: what was pending before it is not carried into it", () => {
    const wakes = createPendingWake();
    wakes.begin("a");
    wakes.signal();
    wakes.begin("a");
    expect(wakes.take()).toBe(false);
  });
});

// ---- the sync engine ----------------------------------------------------------------------------------------------------------
type EngineW = Awaited<ReturnType<typeof engineWorld>>;

/** A response whose BODY is held: the step has read nothing of it until `release()`. */
function holdBody(response: Response): () => void {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = response.arrayBuffer.bind(response);
  response.arrayBuffer = async () => {
    const bytes = await read();
    await held;
    return bytes;
  };
  return () => release();
}

/** The next request is held until `release(answer)`; the answer is a response or an error the wrapper would raise. */
function holdRequest(w: EngineW): (answer: Response | Error) => void {
  let release: (answer: Response | Error) => void = () => undefined;
  w.script.push(
    () => new Promise<Response | Error>((resolve) => (release = resolve)),
  );
  return (answer) => release(answer);
}

describe("the sync engine: a wake during a step", () => {
  test("an identity that moved to a new epoch while a page decodes: the stale page is dropped and the engine asks again under the new one", async () => {
    const w = await engineWorld();
    const response = w.emptyPage("old");
    const release = holdBody(response);
    w.script.push(response);
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    await w.settle();
    release();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(1);
    expect(w.sync().stamp?.epoch).toBe(2);
    await w.advance(60_000);
    w.engine.stop();
  });

  test("the control: the same wake after the step has settled starts fresh work", async () => {
    const w = await engineWorld();
    const response = w.emptyPage("old");
    const release = holdBody(response);
    w.script.push(response);
    w.start();
    await w.settle();
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    release();
    await w.settle();
    w.fire();
    await w.settle();
    expect(w.requests.length).toBeGreaterThan(1);
    w.engine.stop();
  });

  test("the identity moves twice during a step that leaves nothing scheduled: one evaluation reads the LATEST sign-in", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.script.push(new StampedRequestError("closed"));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    w.identity.move({ account: ACCOUNT, epoch: 3 });
    w.fire();
    release(new StampedRequestError("closed"));
    await w.settle();
    // `closed` leaves nothing scheduled ("resume when the view returns"): the sign-in that is current now is what is read.
    expect(w.requests).toHaveLength(2);
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("connectivity lost during a step that leaves nothing scheduled: the engine says so (waiting offline), not the state the step left", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    w.online = false;
    w.fire();
    release(new StampedRequestError("closed"));
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("the service ends during a step that leaves nothing scheduled: the engine says there is no cache to sync, not the state the step left", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    w.service.dispose("closed");
    w.fire();
    release(new StampedRequestError("closed"));
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a notification that changes nothing the step reads is not news: no second request, no loop", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    for (let i = 0; i < 5; i += 1) w.fire();
    release(new StampedRequestError("closed"));
    await w.settle();
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    w.engine.stop();
  });

  test("a source that notifies on every request cannot feed itself", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 50; i += 1)
      w.script.push(async () => {
        // The step's own request makes the session publish: a new identity OBJECT, the same sign-in.
        w.fire();
        return new StampedRequestError("closed");
      });
    w.start();
    await w.settle();
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a source whose changes are real asks once per change and no more", async () => {
    const w = await engineWorld();
    for (let epoch = 2; epoch <= 5; epoch += 1)
      w.script.push(async () => {
        w.identity.move({ account: ACCOUNT, epoch });
        w.fire();
        return new StampedRequestError("closed");
      });
    w.start();
    await w.settle();
    // The first request, then one per change: four changes, five requests, and the fifth (the script is empty) is a healthy page.
    expect(w.requests).toHaveLength(5);
    expect(w.state().kind).toBe("idle");
    await w.advance(30_000);
    expect(w.requests).toHaveLength(5);
    w.engine.stop();
  });

  test("a back-off the step set STANDS: a change during the failing request does not evaluate again at once", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.script.push(w.status(503), w.status(503));
    w.start();
    await w.settle();
    // The page went offline during the request, and the notification said so.
    w.online = false;
    w.fire();
    release(w.status(503));
    await w.settle();
    // A second evaluation now would have said `waiting / offline`; the back-off the step set is what stands.
    expect(w.state().kind).toBe("backing_off");
    expect(w.requests).toHaveLength(1);
    await w.advance(2_100);
    expect(w.state()).toEqual({ kind: "waiting", reason: "offline" });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("the idle poll after a healthy page STANDS: a change during the request does not shorten it", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    w.online = false;
    w.fire();
    w.online = true;
    w.fire();
    release(w.emptyPage("cursor-1"));
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.requests).toHaveLength(1);
    await w.advance(59_000);
    expect(w.requests).toHaveLength(1);
    await w.advance(2_000);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("`online` during a failing request costs one request, after the back-off, and never two", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    for (let i = 0; i < 20; i += 1) w.script.push(w.status(503));
    w.start();
    await w.settle();
    w.online = false;
    w.fire();
    w.goOnline();
    release(w.status(503));
    await w.settle();
    expect(w.requests).toHaveLength(1);
    await w.advance(2_100);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("an explicit `Retry now` during a step that leaves nothing scheduled is evaluated once, not lost", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.script.push(new StampedRequestError("closed"));
    w.start();
    await w.settle();
    w.engine.retryNow();
    await w.settle();
    release(new StampedRequestError("closed"));
    await w.settle();
    expect(w.requests).toHaveLength(2);
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("`online` during a step that leaves nothing scheduled is evaluated once, not lost", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.script.push(new StampedRequestError("closed"));
    w.start();
    await w.settle();
    w.goOnline();
    await w.settle();
    release(new StampedRequestError("closed"));
    await w.settle();
    expect(w.requests).toHaveLength(2);
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("a receipt that is recorded while a step runs is looked at soon, whatever the step decided", async () => {
    const quiet = await engineWorld();
    const releaseQuiet = holdRequest(quiet);
    quiet.start();
    await quiet.settle();
    releaseQuiet(quiet.emptyPage("cursor-1"));
    await quiet.settle();
    await quiet.advance(10_000);
    // The control: with no receipt the idle poll is 60 s.
    expect(quiet.requests).toHaveLength(1);
    quiet.engine.stop();

    const nudged = await engineWorld();
    const release = holdRequest(nudged);
    nudged.start();
    await nudged.settle();
    nudged.engine.nudge("receipt");
    release(nudged.emptyPage("cursor-1"));
    await nudged.settle();
    expect(nudged.state().kind).toBe("idle");
    await nudged.advance(2_100);
    expect(nudged.requests).toHaveLength(2);
    nudged.engine.stop();
  });

  test("a receipt during a step that leaves nothing scheduled is looked at after the receipt pace, not lost", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    w.engine.nudge("receipt");
    release(new StampedRequestError("closed"));
    await w.settle();
    expect(w.requests).toHaveLength(1);
    await w.advance(2_100);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("a receipt NEVER shortens a back-off", async () => {
    const w = await engineWorld();
    w.script.push(w.status(503));
    const release = holdRequest(w);
    for (let i = 0; i < 20; i += 1) w.script.push(w.status(503));
    w.start();
    await w.settle();
    // The first failure backs off 2 s; the second request is held, and the receipt arrives during it.
    await w.advance(2_100);
    expect(w.requests).toHaveLength(2);
    w.engine.nudge("receipt");
    release(w.status(503));
    await w.settle();
    expect(w.state().kind).toBe("backing_off");
    // The second failure backs off 4 s: the receipt pace (2 s) must not shorten it.
    await w.advance(2_500);
    expect(w.requests).toHaveLength(2);
    await w.advance(2_000);
    expect(w.requests).toHaveLength(3);
    w.engine.stop();
  });

  test("a stop and a start while a step is held: the new run is handed the engine once, and the old run's wake is not the new run's", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.script.push(new StampedRequestError("closed"));
    w.start();
    await w.settle();
    w.fire();
    w.engine.stop();
    w.start();
    await w.settle();
    release(new StampedRequestError("closed"));
    await w.settle();
    // One request for the old run, one for the new: the hand-over, nothing more.
    expect(w.requests).toHaveLength(2);
    await w.advance(3_600_000);
    expect(w.requests).toHaveLength(2);
    w.engine.stop();
  });

  test("a receipt nudge of a run that was stopped is not the next run's: its first step keeps its idle poll", async () => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    w.engine.nudge("receipt");
    w.engine.stop();
    w.start();
    await w.settle();
    release(w.emptyPage("old"));
    await w.settle();
    // The old step's request, then the new run's first (handed over): a healthy page, and the idle poll is a minute away.
    expect(w.requests).toHaveLength(2);
    expect(w.state().kind).toBe("idle");
    await w.advance(10_000);
    expect(w.requests).toHaveLength(2);
    await w.advance(55_000);
    expect(w.requests).toHaveLength(3);
    w.engine.stop();
  });

  test("one request is in flight at a time, however many wakes arrive", async () => {
    const w = await engineWorld();
    let open = 0;
    let most = 0;
    for (let i = 0; i < 30; i += 1)
      w.script.push(async () => {
        open += 1;
        most = Math.max(most, open);
        for (let k = 0; k < 4; k += 1) {
          w.identity.move({ account: ACCOUNT, epoch: 2 + i * 4 + k });
          w.fire();
          w.engine.nudge("now");
          w.engine.retryNow();
          await Promise.resolve();
        }
        open -= 1;
        return new StampedRequestError("closed");
      });
    w.start();
    await w.settle();
    await w.advance(600_000);
    expect(most).toBe(1);
    w.engine.stop();
  });
});

describe("a stop the step decided is left only by an explicit retry (found by E-C6, revision 10)", () => {
  /**
   * The `410` that the engine admits and writes (`invalidateRecoveryPosition`) with NO recovery job registered ends in
   * `stopped / no_recovery`, a state nothing durable holds: the capture gate's own word for the same facts (the cache is invalid) is
   * `waiting / cache_not_valid`. The first version of the honoured wake evaluated again after that step whenever a wake arrived while it
   * ran, so the state a landed write leaves depended on how many wakes happened to arrive (E-C6 pins it, in three real engines: the
   * `online` event and the nudge that follow a retry are two wakes).
   */
  const landedWith = async (wake: (w: EngineW) => void) => {
    const w = await engineWorld();
    const release = holdRequest(w);
    w.start();
    await w.settle();
    wake(w);
    await w.settle();
    release(w.status(410));
    await w.settle();
    return w;
  };

  test.each([
    ["`online`", (w: EngineW) => w.goOnline()],
    ["a nudge", (w: EngineW) => w.engine.nudge("now")],
    [
      "the event and the nudge together",
      (w: EngineW) => {
        w.goOnline();
        w.engine.nudge("now");
      },
    ],
  ])(
    "%s while the landed invalidation is decided leaves the stop as the step left it",
    async (_name, wake) => {
      const w = await landedWith(wake);
      expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
      expect(w.sync().cache_status).toBe("invalid");
      expect(w.requests).toHaveLength(1);
      await w.advance(3_600_000);
      expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
      w.engine.stop();
    },
  );

  test("a receipt nudge while it is decided is not looked at either: there is nothing to ask while the engine is stopped", async () => {
    const w = await landedWith((w) => w.engine.nudge("receipt"));
    expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
    await w.advance(10_000);
    expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("an explicit `Retry now` while it is decided IS evaluated: the stop is the person's to lift, and the gate speaks", async () => {
    const w = await landedWith((w) => w.engine.retryNow());
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    expect(w.sync().cache_status).toBe("invalid");
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
  });

  test("a `Retry now` of a run that was stopped is not the next run's: its first step leaves the stop it decides alone", async () => {
    const w = await engineWorld();
    const releaseOld = holdRequest(w);
    const releaseNew = holdRequest(w);
    w.start();
    await w.settle();
    w.engine.retryNow();
    await w.settle();
    w.engine.stop();
    w.start();
    await w.settle();
    // The old run's step unwinds; the new run's first step asks and is held.
    releaseOld(new StampedRequestError("closed"));
    await w.settle();
    expect(w.requests).toHaveLength(2);
    w.goOnline();
    await w.settle();
    releaseNew(w.status(410));
    await w.settle();
    expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
    w.engine.stop();
  });

  test("the control: a wake AFTER the step has settled is the gate's word, as it always was (so the stop was never stable against a later wake)", async () => {
    const w = await landedWith(() => undefined);
    expect(w.state()).toEqual({ kind: "stopped", cause: "no_recovery" });
    w.fire();
    w.goOnline();
    await w.settle();
    expect(w.state()).toEqual({ kind: "waiting", reason: "cache_not_valid" });
    w.engine.stop();
  });
});

// ---- the outbox dispatcher ----------------------------------------------------------------------------------------------------
type OutboxW = Awaited<ReturnType<typeof outboxWorld>>;

const target = (id: string, over: Partial<TargetSpec> = {}): TargetSpec => ({
  resourceId: id,
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
  ...over,
});
const create = (id: string): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [target(id)],
  build: () => ({ command: { kind: "create", id } }),
});

async function started(options: Parameters<typeof outboxWorld>[0] = {}) {
  const w = await outboxWorld(options);
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  return w;
}

/** The dispatcher's NEXT read of its window is held after it has been read: the step has seen the queue as it was. */
function holdWindowRead(w: OutboxW): { release(): void; reached(): boolean } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = w.service.store.run.bind(w.service.store);
  let armed = true;
  let reached = false;
  w.service.store.run = (async (plan: never, input: never, opts: never) => {
    const out = await original(plan, input, opts);
    if (
      (plan as { name: string }).name === "data.readDispatchWindow" &&
      armed
    ) {
      armed = false;
      reached = true;
      await held;
    }
    return out;
  }) as never;
  return { release: () => release(), reached: () => reached };
}

/** How many times a plan has run since this was called (the dispatcher's reads of its queue, for example). */
function countRuns(w: OutboxW, name: string): () => number {
  const original = w.service.store.run.bind(w.service.store);
  let runs = 0;
  w.service.store.run = (async (plan: never, input: never, opts: never) => {
    if ((plan as { name: string }).name === name) runs += 1;
    return original(plan, input, opts);
  }) as never;
  return () => runs;
}

const states = (w: OutboxW) => w.drafts().map((d) => d.status);

describe("the dispatcher: a wake during a step", () => {
  test("a draft saved while the step holds an EMPTY read of the queue is sent: the review's schedule", async () => {
    const w = await started();
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    const saved = await w.outbox.enqueue(create("new"));
    expect(saved.kind).toBe("queued");
    await w.settle();
    expect(w.sent).toHaveLength(0);
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(states(w)).toEqual(["acknowledged"]);
    await w.advance(3_600_000);
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
  });

  test("the control: the same save after the empty step has settled is sent", async () => {
    const w = await started();
    w.start();
    await w.settle();
    await w.outbox.enqueue(create("new"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
  });

  test("a draft saved while the step holds a read that shows ANOTHER draft backing off is sent now, and the other is not sent early", async () => {
    const w = await started();
    w.script.push(new Error("network down"));
    w.start();
    await w.settle();
    await w.outbox.enqueue(create("a"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(w.dispatcher.state.get().kind).toBe("backing_off");
    // `a` waits out its own back-off (2 s). A step begins and holds its read of the queue: only `a`, backing off, is in it.
    const hold = holdWindowRead(w);
    w.fire();
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    await w.settle();
    expect(hold.reached()).toBe(true);
    const saved = await w.outbox.enqueue(create("b"));
    expect(saved.kind).toBe("queued");
    hold.release();
    await w.settle();
    // `b` is sent at once (one draft's back-off never blocks another), and `a` is not sent before its own deadline.
    expect(w.sent.map((r) => r.key)).toHaveLength(2);
    expect(w.sent[1]?.body).toContain('"id":"b"');
    await w.advance(100);
    expect(w.sent).toHaveLength(2);
    await w.advance(3_000);
    expect(w.sent.length).toBeGreaterThan(2);
    w.dispatcher.stop();
  });

  test("an identity that moved to a new epoch while a send was in flight: the answer is dropped and the same draft is sent again under the same key", async () => {
    const w = await started();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    await w.outbox.enqueue(create("a"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    release(w.receipt());
    await w.settle();
    // Either the receipt was admitted under the stamp it was sent with, or it was dropped and the draft is sent again under its own
    // key; in both the draft ends settled, and nothing waits for a wake that was already delivered.
    await w.advance(5_000);
    expect(states(w)).toEqual(["acknowledged"]);
    const keys = new Set(w.sent.map((r) => r.key));
    expect(keys.size).toBe(1);
    w.dispatcher.stop();
  });

  test("the API compatibility fact that turns unsupported during a step is read when the step ends: the queue pauses visibly, and nothing is sent", async () => {
    const w = await started();
    // A draft is already saved (no wake arrives for it): the only news during the step is the compatibility fact.
    await w.outbox.enqueue(create("a"));
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.compat.set({ status: "unsupported", version: "9.9.9" } as never);
    await w.settle();
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(0);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "paused",
      reason: "compat_unsupported",
    });
    w.compat.set({ status: "supported", version: "0.28.0" } as never);
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
  });

  test("an identity that moved to a new epoch during a step is read when the step ends: the draft is sent under the new sign-in, not left", async () => {
    const w = await started();
    await w.outbox.enqueue(create("a"));
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.identity.move({ account: ACCOUNT, epoch: 2 });
    w.fire();
    await w.settle();
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    expect(states(w)).toEqual(["acknowledged"]);
    w.dispatcher.stop();
  });

  /** The queue with one draft that has been paused by a sustained outage (it needs `online` or `Retry now`). */
  async function paused() {
    const w = await started();
    for (let i = 0; i < 40; i += 1)
      w.script.push(w.error(503, "temporarily_unavailable"));
    w.start();
    await w.settle();
    const saved = await w.outbox.enqueue(create("a"));
    await w.settle();
    for (
      let i = 0;
      i < 60 && w.dispatcher.state.get().kind !== "needs_retry";
      i += 1
    )
      await w.advance(10_000);
    expect(w.dispatcher.state.get().kind).toBe("needs_retry");
    return { w, saved };
  }

  test("`online` during a step resumes a paused draft once the step ends", async () => {
    const { w } = await paused();
    const before = w.sent.length;
    const hold = holdWindowRead(w);
    // A step begins (a notification that changes nothing) and holds its read of the queue; the only news is `online`.
    w.fire();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.goOnline();
    await w.settle();
    hold.release();
    await w.settle();
    expect(w.sent.length).toBe(before + 1);
    w.dispatcher.stop();
  });

  test("`Retry now` during a step sends the draft it covers once the step ends", async () => {
    const { w, saved } = await paused();
    const before = w.sent.length;
    const hold = holdWindowRead(w);
    // A step begins (a notification that changes nothing) and holds its read of the queue; the only news is the person's `Retry now`.
    w.fire();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.dispatcher.retry(saved.kind === "queued" ? saved.localId : undefined);
    await w.settle();
    hold.release();
    await w.settle();
    expect(w.sent.length).toBe(before + 1);
    w.dispatcher.stop();
  });

  test("connectivity lost during a step is read when the step ends: the dispatcher says it is waiting offline, and sends nothing", async () => {
    const w = await started();
    await w.outbox.enqueue(create("a"));
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.online = false;
    w.fire();
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(0);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "offline",
    });
    w.dispatcher.stop();
  });

  test("the service ending during a step is read when the step ends: the dispatcher says there is no account, and sends nothing", async () => {
    const w = await started();
    await w.outbox.enqueue(create("a"));
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    w.service.dispose("closed");
    w.fire();
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(0);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "waiting",
      reason: "no_account",
    });
    w.dispatcher.stop();
  });

  test("a save is an explicit act and counts although nothing a step reads has changed", async () => {
    const w = await started();
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    // No identity, connectivity or compatibility change: only the save.
    await w.outbox.enqueue(create("a"));
    hold.release();
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.stop();
  });

  test("the wake that is honoured begins the queue again from its OLDEST draft: after a window with no pick, the queue is not scanned on from where it stopped", async () => {
    const w = await started();
    // A conflict at the head holds every draft that shares its target: 150 drafts behind it, so the first window (100) finds no pick and
    // the dispatcher would continue from where that window ended.
    const rows = [
      draftRow({
        local_id: "conflict",
        created_seq: 1,
        status: "version_conflict",
        index_targets: ["hot"],
        target_resource_ids: ["hot"],
      } as never),
      ...Array.from({ length: 150 }, (_, i) =>
        draftRow({
          local_id: `d${String(i).padStart(3, "0")}`,
          created_seq: i + 2,
          index_targets: ["hot"],
          target_resource_ids: ["hot"],
        } as never),
      ),
    ];
    w.put("drafts", rows);
    w.setSync({ draft_seq: 200 });
    const windows = countRuns(w, "data.readDispatchWindow");
    let windowsAtFirstSend = -1;
    w.script.push(() => {
      windowsAtFirstSend = windows();
      return w.receipt();
    });
    const hold = holdWindowRead(w);
    w.start();
    await w.settle();
    expect(hold.reached()).toBe(true);
    // Discarding the conflict (an explicit act, which wakes the dispatcher) arrives while that first window is held.
    const out = await w.outbox.discard("conflict");
    expect(out.kind).toBe("discarded");
    hold.release();
    await w.settle();
    // The oldest draft is sent after ONE more window, read from the start; continuing from where the first stopped would have taken
    // the rest of the queue's windows first.
    expect(w.sent[0]?.key).toBe("d000");
    expect(windowsAtFirstSend).toBe(2);
    w.dispatcher.stop();
  });

  test("a notification that changes nothing is not news: no feedback loop, and the queue is read a bounded number of times", async () => {
    const w = await started();
    w.start();
    await w.settle();
    const reads = countRuns(w, "data.readDispatchWindow");
    const before = reads();
    for (let i = 0; i < 40; i += 1)
      w.script.push(async () => {
        // The step's own request makes the session publish a new identity object (the same sign-in), and compat re-announces itself.
        w.fire();
        w.compat.set({ ...w.compat.get() });
        return new StampedRequestError("closed");
      });
    await w.outbox.enqueue(create("a"));
    await w.settle();
    await w.advance(3_600_000);
    expect(w.sent).toHaveLength(1);
    // The save's own turn, the step that answered it and, at most, one more: not a read per notification.
    expect(reads() - before).toBeLessThanOrEqual(4);
    w.dispatcher.stop();
  });

  test("one request is in flight at a time, however many wakes arrive", async () => {
    const w = await started();
    let open = 0;
    let most = 0;
    for (let i = 0; i < 30; i += 1)
      w.script.push(async () => {
        open += 1;
        most = Math.max(most, open);
        for (let k = 0; k < 4; k += 1) {
          w.fire();
          w.dispatcher.wake();
          await Promise.resolve();
        }
        open -= 1;
        return w.receipt();
      });
    w.start();
    await w.settle();
    for (let i = 0; i < 6; i += 1) await w.outbox.enqueue(create(`n${i}`));
    await w.settle();
    await w.advance(60_000);
    expect(most).toBe(1);
    expect(w.sent).toHaveLength(6);
    expect(states(w)).toEqual(Array(6).fill("acknowledged"));
    w.dispatcher.stop();
  });

  test("a stop and a start while a send is held: the new run is handed the queue once, and nothing is sent twice at once", async () => {
    const w = await started();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    await w.outbox.enqueue(create("a"));
    await w.settle();
    expect(w.sent).toHaveLength(1);
    w.dispatcher.wake();
    w.dispatcher.stop();
    w.start();
    await w.settle();
    release(w.receipt());
    await w.settle();
    await w.advance(60_000);
    expect(states(w)).toEqual(["acknowledged"]);
    w.dispatcher.stop();
  });
});

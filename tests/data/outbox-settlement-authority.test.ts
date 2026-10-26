// @vitest-environment node
import { describe, expect, test } from "vitest";
import { LOCAL_WRITE_STOPS_STORE } from "../../src/data/engine/sync-channel";
import type { SyncOwnership } from "../../src/data/engine/sync-engine";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * F-13b-1b and F-13b-1c (WEB-13b revision 5, review 5; handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`): what the
 * settlement of an issued answer owes, and the stop its failure records, belong to the act and the binding that made them.
 *
 *  - F-13b-1b: the person's retry lifted EVERY obligation of the drafts it named when its awaited work completed, not the ones it saw
 *    when it was made. Two overlapping retries after a visible full disk: the second sent the draft, its answer met a full disk again (a
 *    NEW hold), and the first retry's late completion erased that hold, so the next wake sent the draft a third time. The obligations are
 *    now instances (`owed`), witnessed where the retry is admitted and retired by instance, and kept apart from the run's own schedule.
 *  - F-13b-1c: a failure whose counter could not be written created its fallback stop (the marker, or the page's memory) after an await,
 *    asking only whether the account's SERVICE stood. The service outlives the leadership binding, so an ended binding's late callback
 *    left a marker that stopped the account's next owner on a failure that owner never met. The binding is now asked too, after every
 *    wait, up to the synchronous creation of the stop.
 *
 * The schedules are the design assessment's Q1-Q7, Q9 and Q10, each split at the boundary the review found: a transaction's COMMIT and the
 * DELIVERY of its result to the dispatcher (`holdDelivery`). Every send is held until the case answers it; every fault is a named
 * injection whose hits are asserted; the binding's end is the leader's (its ownership aborted and its dispatcher stopped, the account's
 * service left live), asserted in each case.
 *
 * FIXTURE evidence: the production facade, dispatcher and plans over the doubles of IndexedDB and `localStorage`, fake time; no backend.
 * The leader's composition of the same schedules is in `leader-forbidden.test.ts`, the real engine's in `fixture.data-forbidden.spec.ts`.
 */
const RECORD = "data.recordOutcome";
const RECEIPT = "data.admitReceipt";
const COUNTER = "data.recordLocalWriteOutcome";
const RESUME = "data.resumeDrafts";
const SEND_FAILURE = "data.recordFailureOfSend";

const request = (localId: string, target = "r"): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: target,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  build: (bases) => ({
    command: {
      kind: "edit",
      id: target,
      label: localId,
      expected_version: bases[target] as number,
    },
  }),
});

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r", version: 5 }),
    cacheRow({ id: "s", version: 5 }),
  ]);
  return w;
}
const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};

/** A named injection whose hits are counted, so a case can show that its fault fired. */
function fail(
  w: OutboxWorld,
  label: string,
  times: number,
  mode: "error" | "quota" = "error",
) {
  const hits = { count: 0 };
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label !== label || hits.count >= times) return false;
      hits.count += 1;
      return true;
    },
    mode,
    times,
  });
  return hits;
}

/**
 * Holds the DELIVERY of one run of the plan `name` (the `skip`-th after those it lets through): the transaction runs and commits (or
 * fails) at once, and the dispatcher or the facade that asked hears of it only at `release()`.
 */
function holdDelivery(w: OutboxWorld, name: string, skip = 0) {
  const store = w.service.store as unknown as {
    run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
  };
  const real = store.run.bind(store);
  let seen = 0;
  let hits = 0;
  let release = () => {};
  store.run = (plan, ...rest) => {
    const result = real(plan, ...rest);
    if (plan.name !== name) return result;
    seen += 1;
    if (seen !== skip + 1) return result;
    hits += 1;
    return new Promise((resolve, reject) =>
      result.then(
        (value) => {
          release = () => resolve(value);
        },
        (error) => {
          release = () => reject(error);
        },
      ),
    );
  };
  return {
    get hits() {
      return hits;
    },
    release: () => release(),
  };
}

/** Every send is HELD until the case answers it (a response, or an error the request throws), counted where it is made. */
function heldSends(w: OutboxWorld) {
  const at: number[] = [];
  const pending: Array<(answer: Response | Error) => void> = [];
  const push = () =>
    w.script.push(() => {
      at.push(w.now());
      push();
      return new Promise<Response | Error>((resolve) => {
        pending.push(resolve);
      });
    });
  push();
  return {
    at,
    async answer(response: Response | Error) {
      const release = pending.shift();
      if (release === undefined) throw new Error("setup: no send is held");
      release(response);
      await w.settle();
    },
  };
}

/** The leader's stop of the run while the display is closed, and its start of a run with the same ownership when it opens. */
async function interrupt(w: OutboxWorld) {
  w.dispatcher.stop();
  await w.settle();
  w.start();
  await w.settle();
}

/** The leader's unbind: the ownership aborts, the dispatcher stops and the facade's observation ends; the account's service goes on. */
async function endBinding(w: OutboxWorld) {
  w.ownership.abort();
  w.dispatcher.stop();
  w.outbox.disposeObservation();
  await w.settle();
  expect(w.ownership.value.signal.aborted).toBe(true);
  expect(w.service.live, "the service outlives the binding").toBe(true);
}

/** The account's next owner on this page: a new dispatcher and facade over the same database and markers, under a new ownership. */
async function successor(w: OutboxWorld) {
  w.rebuild();
  w.dispatcher.start({ token: null, signal: new AbortController().signal });
  await w.settle();
}

/** One draft `a`, queued and sent, its answer held. */
async function sentOnce(w: OutboxWorld) {
  expect((await w.outbox.enqueue(request("a"))).kind).toBe("queued");
  const sends = heldSends(w);
  w.online = true;
  w.start();
  await w.settle();
  expect(sends.at).toHaveLength(1);
  return sends;
}

/** `a` sent once and answered `403`, its record refused for want of space (`faults` such refusals in all): the hold is SHOWN. */
async function visibleHold(w: OutboxWorld, faults: number) {
  const sends = await sentOnce(w);
  const hits = fail(w, RECORD, faults, "quota");
  await interrupt(w);
  await sends.answer(w.error(403, "forbidden"));
  expect(hits.count).toBe(1);
  expect(w.dispatcher.state.get()).toEqual({
    kind: "stopped",
    cause: "storage_full",
  });
  return { sends, hits };
}

type Via = "dispatcher" | "facade";
const retry = (w: OutboxWorld, via: Via, localId?: string): void =>
  (via === "dispatcher" ? w.dispatcher : w.outbox).retry(localId);

/** Wakes, notifications, `online`, a restart of the binding and time: none of them is the person's retry. */
async function everythingButARetry(w: OutboxWorld) {
  w.dispatcher.wake();
  w.fire();
  w.goOnline();
  await w.settle();
  await interrupt(w);
  await w.advance(5 * 60_000);
}

const streaks = (w: OutboxWorld) => w.sync().local_write_streaks ?? {};
const draftA = (w: OutboxWorld) => w.drafts().find((d) => d.local_id === "a");
const marks = (w: OutboxWorld) => w.markers.inspect(w.service).operations;
const memoryStops = (w: OutboxWorld) =>
  w.dispatcher.stops?.operations(w.service) ?? [];
const stopHints = (w: OutboxWorld) =>
  w.posted.filter(
    (m) =>
      m.type === "data_changed" &&
      (m as { stores?: readonly string[] }).stores?.includes(
        LOCAL_WRITE_STOPS_STORE,
      ),
  ).length;
/** Every send of `a` carried the same key and the same body (an immutable operation replayed, never rebuilt). */
const sameOperation = (w: OutboxWorld) => {
  const sent = w.sent.filter((s) => s.key === "a");
  expect(new Set(sent.map((s) => s.body)).size).toBe(1);
};

describe("F-13b-1b: the person's retry lifts the holds it saw, and no hold met since", () => {
  for (const via of ["dispatcher", "facade"] as const)
    for (const scope of ["the draft", "every draft"] as const)
      for (const again of [true, false])
        test(`Q1 ${via}, ${scope}: two overlapping retries after a visible full disk, the first one's completion delivered last; ${again ? "the second answer meets a full disk again and that NEW hold stands" : "control: the second answer is recorded, and the queue is idle"}`, async () => {
          const w = await world();
          try {
            const { sends, hits } = await visibleHold(w, again ? 2 : 1);
            const localId = scope === "the draft" ? "a" : undefined;
            const first = holdDelivery(w, RESUME);
            retry(w, via, localId);
            await w.settle();
            expect(first.hits, "the first retry's resume committed").toBe(1);
            expect(sends.at, "its completion is held").toHaveLength(1);
            retry(w, via, localId);
            await w.settle();
            expect(sends.at, "the second retry sent the draft").toHaveLength(2);
            await interrupt(w);
            await sends.answer(w.error(403, "forbidden"));
            expect(hits.count).toBe(again ? 2 : 1);
            first.release();
            await w.settle();
            await everythingButARetry(w);
            expect(
              sends.at,
              "both retries saw the first hold only; neither lifts a later one",
            ).toHaveLength(2);
            sameOperation(w);
            expect(streaks(w), "a full disk is not a streak").toEqual({});
            if (!again) {
              expect(draftA(w)).toMatchObject({ status: "rejected" });
              expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
              return;
            }
            expect(w.dispatcher.state.get()).toEqual({
              kind: "stopped",
              cause: "storage_full",
            });
            expect(draftA(w)).toMatchObject({ status: "in_flight" });
            // The person's retry of the hold they now see sends it once more.
            retry(w, via, localId);
            await w.settle();
            expect(sends.at).toHaveLength(3);
            await sends.answer(w.error(403, "forbidden"));
            expect(draftA(w)).toMatchObject({ status: "rejected" });
          } finally {
            finish(w);
          }
        });

  for (const via of ["dispatcher", "facade"] as const)
    test(`Q1 ${via}, the other order: the first retry completes and sends, the second is made while that send is out and its completion is delivered after a NEW full disk; the new hold stands`, async () => {
      const w = await world();
      try {
        const { sends, hits } = await visibleHold(w, 2);
        retry(w, via, "a");
        await w.settle();
        expect(sends.at).toHaveLength(2);
        const second = holdDelivery(w, RESUME);
        retry(w, via, "a");
        await w.settle();
        expect(second.hits).toBe(1);
        await interrupt(w);
        await sends.answer(w.error(403, "forbidden"));
        expect(hits.count).toBe(2);
        second.release();
        await w.settle();
        await everythingButARetry(w);
        expect(sends.at).toHaveLength(2);
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "storage_full",
        });
      } finally {
        finish(w);
      }
    });

  for (const via of ["dispatcher", "facade"] as const)
    for (const scope of ["the draft", "every draft"] as const)
      test(`Q1 ${via}, ${scope}, the run never interrupted: the second answer meets a full disk again in the run that stands, and the first retry's late completion, in that same run, leaves the NEW hold standing`, async () => {
        const w = await world();
        try {
          const { sends, hits } = await visibleHold(w, 2);
          const localId = scope === "the draft" ? "a" : undefined;
          const first = holdDelivery(w, RESUME);
          retry(w, via, localId);
          await w.settle();
          expect(first.hits).toBe(1);
          retry(w, via, localId);
          await w.settle();
          expect(sends.at).toHaveLength(2);
          await sends.answer(w.error(403, "forbidden"));
          expect(hits.count).toBe(2);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "storage_full",
          });
          first.release();
          await w.settle();
          w.dispatcher.wake();
          w.fire();
          w.goOnline();
          await w.advance(5 * 60_000);
          expect(sends.at).toHaveLength(2);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "storage_full",
          });
        } finally {
          finish(w);
        }
      });

  for (const via of ["dispatcher", "facade"] as const)
    for (const before of [true, false])
      test(`Q2 ${via}: ${before ? "a retry made BEFORE the first full disk was met lifts nothing of it" : "control: a retry made after the full disk was shown sends the draft once"}`, async () => {
        const w = await world();
        try {
          const sends = await sentOnce(w);
          const hits = fail(w, RECORD, 1, "quota");
          await interrupt(w);
          if (!before) await sends.answer(w.error(403, "forbidden"));
          const held = holdDelivery(w, RESUME);
          retry(w, via, "a");
          await w.settle();
          expect(held.hits).toBe(1);
          if (before) await sends.answer(w.error(403, "forbidden"));
          expect(hits.count).toBe(1);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "storage_full",
          });
          held.release();
          await w.settle();
          if (!before) {
            expect(sends.at, "the retry the person made sends it").toHaveLength(
              2,
            );
            await sends.answer(w.error(403, "forbidden"));
            expect(draftA(w)).toMatchObject({ status: "rejected" });
            return;
          }
          await everythingButARetry(w);
          expect(
            sends.at,
            "only a retry that saw the hold resends",
          ).toHaveLength(1);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "storage_full",
          });
        } finally {
          finish(w);
        }
      });
});

describe("F-13b-1b: across restarts and bindings, an older act never ends a newer obligation", () => {
  test("Q3: the binding's run restarts between the new full disk and the old retry's completion; the new hold stands", async () => {
    const w = await world();
    try {
      const { sends, hits } = await visibleHold(w, 2);
      const first = holdDelivery(w, RESUME);
      w.dispatcher.retry("a");
      await w.settle();
      w.dispatcher.retry("a");
      await w.settle();
      expect(sends.at).toHaveLength(2);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count).toBe(2);
      await interrupt(w);
      first.release();
      await w.settle();
      await everythingButARetry(w);
      expect(sends.at).toHaveLength(2);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
    } finally {
      finish(w);
    }
  });

  test("Q3: a retry whose run a restart of the same binding replaced still lifts the hold it saw, and the run that stands sends the draft without another event", async () => {
    const w = await world();
    try {
      const { sends } = await visibleHold(w, 1);
      const held = holdDelivery(w, RESUME);
      w.dispatcher.retry("a");
      await w.settle();
      expect(held.hits).toBe(1);
      await interrupt(w);
      expect(sends.at, "the restart is not a retry").toHaveLength(1);
      held.release();
      await w.settle();
      expect(sends.at).toHaveLength(2);
      sameOperation(w);
    } finally {
      finish(w);
    }
  });

  test("Q3: a retry made under a binding that another replaced lifts nothing of the new binding's hold", async () => {
    const w = await world();
    try {
      const { sends, hits } = await visibleHold(w, 2);
      const held = holdDelivery(w, RESUME);
      w.dispatcher.retry("a");
      await w.settle();
      expect(held.hits).toBe(1);
      w.dispatcher.stop();
      await w.settle();
      const other: SyncOwnership = {
        token: null,
        signal: new AbortController().signal,
      };
      w.dispatcher.start(other);
      await w.settle();
      expect(sends.at, "the new binding inherits no hold").toHaveLength(2);
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count).toBe(2);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
      held.release();
      await w.settle();
      w.dispatcher.wake();
      await w.advance(5 * 60_000);
      expect(sends.at).toHaveLength(2);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
    } finally {
      finish(w);
    }
  });

  test("Q4: a pause renewed at the SAME instant is a new obligation; the older retry's completion ends neither it nor the 250 ms; another draft goes on", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = fail(w, RECORD, 2);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      const firstFailure = w.now();
      expect(streaks(w)).toEqual({ "receipt:a": 1 });
      const first = holdDelivery(w, RESUME);
      w.dispatcher.retry("a");
      await w.settle();
      w.dispatcher.retry("a");
      await w.settle();
      expect(sends.at, "the second retry lifted the pause it saw").toHaveLength(
        2,
      );
      await sends.answer(w.error(403, "forbidden"));
      const secondFailure = w.now();
      expect(hits.count).toBe(2);
      expect(
        secondFailure,
        "both pauses end at the same instant: only their instances differ",
      ).toBe(firstFailure);
      first.release();
      await w.settle();
      expect((await w.outbox.enqueue(request("b", "s"))).kind).toBe("queued");
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a", "b"]);
      await sends.answer(w.receipt(6));
      await w.advance(secondFailure + 249 - w.now());
      expect(sends.at, "not before the 250 ms the failure owes").toHaveLength(
        3,
      );
      await w.advance(1);
      expect(sends.at).toHaveLength(4);
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a", "b", "a"]);
      sameOperation(w);
    } finally {
      finish(w);
    }
  });

  test("Q10: a draft held for a full disk while its request is out cannot be discarded; the draft and the hold stay", async () => {
    const w = await world();
    try {
      await visibleHold(w, 1);
      expect(await w.outbox.discard("a")).toEqual({
        kind: "refused",
        reason: "in_flight",
      });
      await w.settle();
      w.dispatcher.wake();
      await w.settle();
      expect(w.drafts()).toHaveLength(1);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
    } finally {
      finish(w);
    }
  });
});

describe("F-13b-1c: a failure's stop is created only while its binding stands", () => {
  for (const [name, label, answer] of [
    ["an ordinary 403's record", RECORD, "403"],
    ["a receipt's admission", RECEIPT, "receipt"],
  ] as const)
    for (const ended of [true, false])
      test(`Q5 ${name} fails and its counter fails; the counter's rejection is delivered ${ended ? "after the binding ENDED (the service live): no marker, nothing held, and the next owner sends the draft again under its key" : "while the binding stands (control): the fallback marker stops the draft"}`, async () => {
        const w = await world();
        try {
          const sends = await sentOnce(w);
          const record = fail(w, label, 1);
          const counter = fail(w, COUNTER, 1);
          const held = holdDelivery(w, COUNTER);
          await interrupt(w);
          await sends.answer(
            answer === "403" ? w.error(403, "forbidden") : w.receipt(8),
          );
          expect([record.count, counter.count, held.hits]).toEqual([1, 1, 1]);
          if (ended) await endBinding(w);
          held.release();
          await w.settle();
          expect(streaks(w), "no streak is fabricated").toEqual({});
          if (!ended) {
            expect(marks(w)).toEqual(["receipt:a"]);
            await w.advance(5 * 60_000);
            expect(sends.at).toHaveLength(1);
            expect(w.dispatcher.state.get()).toEqual({
              kind: "stopped",
              cause: "local_storage",
            });
            return;
          }
          expect(marks(w), "no marker after the binding ended").toEqual([]);
          expect(memoryStops(w)).toEqual([]);
          expect(w.dispatcher.state.get()).toEqual({ kind: "not_started" });
          expect(draftA(w)).toMatchObject({ status: "in_flight" });
          await successor(w);
          expect(sends.at, "the next owner sends it again").toHaveLength(2);
          sameOperation(w);
          await sends.answer(
            answer === "403" ? w.error(403, "forbidden") : w.receipt(8),
          );
          expect(draftA(w)?.status ?? "settled").not.toBe("in_flight");
          expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
        } finally {
          finish(w);
        }
      });

  for (const ended of [true, false])
    test(`Q6 the counter and the marker both fail; ${ended ? "after the binding ended, nothing is held in the page's memory and the next owner on this page sends" : "control: the binding stands, the page's memory holds the stop and says so"}`, async () => {
      const w = await world();
      try {
        const sends = await sentOnce(w);
        fail(w, RECORD, 1);
        const counter = fail(w, COUNTER, 1);
        const held = holdDelivery(w, COUNTER);
        w.markerStorage.failWrites = true;
        await interrupt(w);
        await sends.answer(w.error(403, "forbidden"));
        expect([counter.count, held.hits]).toEqual([1, 1]);
        if (ended) await endBinding(w);
        held.release();
        await w.settle();
        expect(marks(w)).toEqual([]);
        if (!ended) {
          expect(memoryStops(w)).toEqual(["receipt:a"]);
          await interrupt(w);
          await w.advance(60_000);
          expect(sends.at).toHaveLength(1);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "local_storage",
            memoryOnly: true,
          });
          return;
        }
        expect(memoryStops(w), "nothing in the page's memory").toEqual([]);
        // The next owner on THIS page: the same page memory, the same dispatcher (the leader reuses it), a new ownership.
        w.dispatcher.start({
          token: null,
          signal: new AbortController().signal,
        });
        await w.settle();
        expect(sends.at).toHaveLength(2);
        sameOperation(w);
      } finally {
        finish(w);
      }
    });

  test("Q7 control: a below-bound counter that SUCCEEDS after the binding ended creates nothing, and the next owner sends", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const record = fail(w, RECORD, 1);
      const held = holdDelivery(w, COUNTER);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect([record.count, held.hits]).toEqual([1, 1]);
      await endBinding(w);
      held.release();
      await w.settle();
      expect(streaks(w), "the counter committed").toEqual({ "receipt:a": 1 });
      expect(marks(w)).toEqual([]);
      expect(memoryStops(w)).toEqual([]);
      await successor(w);
      expect(sends.at).toHaveLength(2);
    } finally {
      finish(w);
    }
  });

  test("Q7 a counter that COMMITS the stop at its bound after the binding ended: the stop is a fact of the record, announced, and the next owner stops on it; the ended run shows nothing", async () => {
    const w = await world();
    try {
      w.setSync({ local_write_streaks: { "receipt:a": 2 } });
      const sends = await sentOnce(w);
      const record = fail(w, RECORD, 1);
      const held = holdDelivery(w, COUNTER);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect([record.count, held.hits]).toEqual([1, 1]);
      await endBinding(w);
      const hintsBefore = stopHints(w);
      held.release();
      await w.settle();
      expect(streaks(w)).toEqual({ "receipt:a": 3 });
      expect(stopHints(w), "the committed stop is announced").toBe(
        hintsBefore + 1,
      );
      expect(w.dispatcher.state.get()).toEqual({ kind: "not_started" });
      expect(marks(w), "no fallback beside the durable stop").toEqual([]);
      await successor(w);
      await w.advance(60_000);
      expect(sends.at).toHaveLength(1);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
    } finally {
      finish(w);
    }
  });

  for (const ended of [true, false])
    test(`Q9 a request that got no answer, whose failure could not be recorded: ${ended ? "after the binding ended, nothing is counted or recorded for it" : "control: the binding stands, the failure of its record is counted"}`, async () => {
      const w = await world();
      try {
        const sends = await sentOnce(w);
        const record = fail(w, SEND_FAILURE, 1);
        if (ended) await endBinding(w);
        await sends.answer(new TypeError("network"));
        expect(record.count).toBe(1);
        expect(marks(w)).toEqual([]);
        if (!ended) {
          expect(streaks(w)).toEqual({ "receipt:a": 1 });
          return;
        }
        expect(streaks(w), "nothing counted for an ended binding").toEqual({});
        expect(memoryStops(w)).toEqual([]);
        await successor(w);
        expect(sends.at).toHaveLength(2);
        sameOperation(w);
      } finally {
        finish(w);
      }
    });
});

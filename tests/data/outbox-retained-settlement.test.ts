// @vitest-environment node
import { describe, expect, test } from "vitest";
import { LOCAL_WRITE_STOPS_STORE } from "../../src/data/engine/sync-channel";
import type { SyncOwnership } from "../../src/data/engine/sync-engine";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { nextDelay } from "../../src/data/model/retry";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * F-13b-1a (WEB-13b revision 4, review 4; handover `delivery/handoffs/web13b-foundation-403-approved-20261025.md`): the record of an ISSUED
 * answer that a run which has ENDED delivers is the binding's, so a failure to record it is counted, paced and stopped exactly as a live
 * run's is. Revision 3 settled such an answer when its commit succeeded, but returned for the ended run BEFORE looking at a failed commit:
 * no streak, no pause, no stop, and the run that took over sent the unchanged `in_flight` draft again at once (four sends where three are
 * the bound; a second send after a full disk).
 *
 * The leader stops the run while the account's display is closed and starts one with the SAME ownership when it opens (the session closes
 * it for a moment around every `403`); here that is `stop()` then `start()` of the production dispatcher with the world's one ownership
 * (`interrupt`), in both orders around the answer. What the settlement owes after its run (the 250 ms pause after a below-bound failure,
 * the hold after a full disk) is owed to that binding's runs, enforced where a draft is picked; another binding inherits nothing.
 *
 * FIXTURE evidence: the production facade, dispatcher and plans over the doubles of IndexedDB and `localStorage`, fake time; failures are
 * NAMED injections, each one asserted to have fired; no backend.
 */
const RECORD = "data.recordOutcome";
const RECEIPT = "data.admitReceipt";
const COUNTER = "data.recordLocalWriteOutcome";

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

/** A named injection whose hits are counted, so a case can show that its fault fired (a fault that never fired proves nothing). */
function fail(
  w: OutboxWorld,
  label: string,
  times: number,
  mode: "error" | "quota" | "closed" = "error",
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
 * Every send of a draft is HELD until the case answers it (`answer`), so a defective dispatcher cannot run on unseen: the sends are
 * counted where they are made, with the time each was made.
 */
function heldSends(w: OutboxWorld) {
  const at: number[] = [];
  const pending: Array<(answer: Response) => void> = [];
  const push = () =>
    w.script.push(() => {
      at.push(w.now());
      push();
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    });
  push();
  return {
    at,
    async answer(response: Response) {
      const release = pending.shift();
      if (release === undefined) throw new Error("setup: no send is held");
      release(response);
      await w.settle();
    },
    get held() {
      return pending.length;
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

const streaks = (w: OutboxWorld) => w.sync().local_write_streaks ?? {};
const draftA = (w: OutboxWorld) => w.drafts().find((d) => d.local_id === "a");
const stopHints = (w: OutboxWorld) =>
  w.posted.filter(
    (m) =>
      m.type === "data_changed" &&
      (m as { stores?: readonly string[] }).stores?.includes(
        LOCAL_WRITE_STOPS_STORE,
      ),
  ).length;

describe("F-13b-1a: the record of an issued answer that failed after its run ended is counted, paced and stopped", () => {
  const answers = [
    ["an ordinary 403", RECORD, (w: OutboxWorld) => w.error(403, "forbidden")],
    ["a 422", RECORD, (w: OutboxWorld) => w.error(422, "invalid_value")],
    ["a receipt", RECEIPT, (w: OutboxWorld) => w.receipt(7)],
  ] as const;

  for (const [name, label, answerOf] of answers)
    for (const interrupted of [true, false])
      test(`${name}, three failed records, ${interrupted ? "the run restarted with the same binding before each answer" : "control: the run never interrupted"}: exactly three sends, streak 1/2/3, 250 ms apart at least, then stopped`, async () => {
        const w = await world();
        try {
          const sends = await sentOnce(w);
          const hits = fail(w, label, 3);
          const hintsBefore = stopHints(w);
          for (let n = 1; n <= 3; n += 1) {
            if (interrupted) await interrupt(w);
            expect(
              sends.at,
              "nothing is sent while an answer is held",
            ).toHaveLength(n);
            await sends.answer(answerOf(w));
            expect(hits.count).toBe(n);
            expect(streaks(w)).toEqual({ "receipt:a": n });
            expect(draftA(w)).toMatchObject({
              status: "in_flight",
              attempts: 0,
            });
            if (n < 3) {
              await w.advance(249);
              expect(sends.at, "not sent again before the pause").toHaveLength(
                n,
              );
              await w.advance(1);
              expect(sends.at).toHaveLength(n + 1);
            }
          }
          await w.advance(5 * 60_000);
          expect(sends.at, "three sends, the bound").toHaveLength(3);
          for (let i = 1; i < sends.at.length; i += 1)
            expect(
              (sends.at[i] as number) - (sends.at[i - 1] as number),
            ).toBeGreaterThanOrEqual(250);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "local_storage",
          });
          // The stop is in the record: the account's other pages are told to read theirs.
          expect(stopHints(w)).toBeGreaterThan(hintsBefore);
          // One request each, under one key, with one body.
          expect(new Set(w.sent.map((s) => s.key))).toEqual(new Set(["a"]));
          expect(new Set(w.sent.map((s) => s.body)).size).toBe(1);
        } finally {
          finish(w);
        }
      });

  test.each([
    ["the run starts again 100 ms after the failure", 100, 150],
    ["the run starts again 300 ms after the failure", 300, 0],
  ])(
    "an answer whose record failed while the display stayed closed: nothing is sent while closed, and the pause still holds when %s",
    async (_, closedFor, stillOwed) => {
      const w = await world();
      try {
        const sends = await sentOnce(w);
        const hits = fail(w, RECORD, 1);
        w.dispatcher.stop();
        await w.settle();
        await sends.answer(w.error(403, "forbidden"));
        expect(hits.count).toBe(1);
        expect(streaks(w)).toEqual({ "receipt:a": 1 });
        await w.advance(closedFor);
        expect(sends.at, "nothing is sent while closed").toHaveLength(1);
        w.start();
        await w.settle();
        if (stillOwed > 0) {
          expect(sends.at).toHaveLength(1);
          await w.advance(stillOwed - 1);
          expect(sends.at).toHaveLength(1);
          await w.advance(1);
        }
        expect(sends.at).toHaveLength(2);
        await sends.answer(w.error(403, "forbidden"));
        expect(draftA(w)).toMatchObject({ status: "rejected", attempts: 1 });
        expect(streaks(w)).toEqual({});
        await w.advance(5 * 60_000);
        expect(sends.at).toHaveLength(2);
        expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
      } finally {
        finish(w);
      }
    },
  );

  for (const interrupted of [true, false])
    test(`a wake, a notification, \`online\` or another save during the pause sends nothing early; the other draft goes on (${interrupted ? "after a restart of the binding" : "control: a live run"})`, async () => {
      const w = await world();
      try {
        const sends = await sentOnce(w);
        const hits = fail(w, RECORD, 1);
        if (interrupted) await interrupt(w);
        await sends.answer(w.error(403, "forbidden"));
        expect(hits.count).toBe(1);
        await w.advance(50);
        w.dispatcher.wake();
        await w.settle();
        w.fire();
        await w.settle();
        w.goOnline();
        await w.settle();
        expect(sends.at).toHaveLength(1);
        expect((await w.outbox.enqueue(request("b", "s"))).kind).toBe("queued");
        await w.settle();
        expect(sends.at, "the other draft is sent (D-18)").toHaveLength(2);
        expect(w.sent[1]?.key).toBe("b");
        await sends.answer(w.receipt(8));
        await w.advance(198);
        expect(w.sent.filter((s) => s.key === "a")).toHaveLength(1);
        await w.advance(2);
        expect(w.sent.filter((s) => s.key === "a")).toHaveLength(2);
      } finally {
        finish(w);
      }
    });

  test("a record the persistence hold could not verify while the run was stopped is paced, not resent at once, and not counted", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      await interrupt(w);
      // Only the record's own hold is refused: every later one (the replacement run's claim) is granted at once.
      w.gate.queue = true;
      await sends.answer(w.error(403, "forbidden"));
      expect(w.gate.waiting).toHaveLength(1);
      const record = w.gate.waiting.shift();
      w.gate.queue = false;
      record?.answer("unavailable");
      await w.settle();
      expect(draftA(w)).toMatchObject({ status: "in_flight", attempts: 0 });
      expect(streaks(w), "an unverified commit is not a failure").toEqual({});
      // The world's jitter is 0.5: the pause of a first unverified commit.
      const pause = nextDelay(1, 0.5, DATA_CONFIG);
      expect(pause).toBeGreaterThan(250);
      await w.advance(pause - 1);
      expect(sends.at).toHaveLength(1);
      await w.advance(1);
      expect(sends.at).toHaveLength(2);
      await sends.answer(w.error(403, "forbidden"));
      expect(draftA(w)).toMatchObject({ status: "rejected", attempts: 1 });
    } finally {
      finish(w);
    }
  });

  test("a record that succeeds after two that failed ends the streak, and nothing more is sent (the run restarted before each answer)", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = fail(w, RECORD, 2);
      for (let n = 1; n <= 2; n += 1) {
        await interrupt(w);
        await sends.answer(w.error(403, "forbidden"));
        expect(streaks(w)).toEqual({ "receipt:a": n });
        await w.advance(250);
      }
      expect(hits.count).toBe(2);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect(draftA(w)).toMatchObject({ status: "rejected", attempts: 1 });
      expect(streaks(w)).toEqual({});
      await w.advance(5 * 60_000);
      expect(sends.at).toHaveLength(3);
      expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    } finally {
      finish(w);
    }
  });
});

describe("F-13b-1a: a full disk met recording an issued answer holds its draft until the person's retry", () => {
  for (const interrupted of [true, false])
    test(`one send, then storage full through wakes, \`online\`, restarts of the binding and another draft's progress; the retry sends it once (${interrupted ? "the run restarted before the answer" : "control: a live run"})`, async () => {
      const w = await world();
      try {
        const sends = await sentOnce(w);
        const hits = fail(w, RECORD, 1, "quota");
        if (interrupted) await interrupt(w);
        await sends.answer(w.error(403, "forbidden"));
        expect(hits.count).toBe(1);
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "storage_full",
        });
        expect(streaks(w), "a full disk is not a streak").toEqual({});
        w.dispatcher.wake();
        w.fire();
        w.goOnline();
        await w.advance(5 * 60_000);
        await interrupt(w);
        await w.advance(60_000);
        expect(sends.at).toHaveLength(1);
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "storage_full",
        });
        // Another draft goes on (D-18), and the state returns to the hold when nothing else is left.
        expect((await w.outbox.enqueue(request("b", "s"))).kind).toBe("queued");
        await w.settle();
        expect(w.sent.map((s) => s.key)).toEqual(["a", "b"]);
        await sends.answer(w.receipt(8));
        await w.advance(1_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a", "b"]);
        expect(w.dispatcher.state.get()).toEqual({
          kind: "stopped",
          cause: "storage_full",
        });
        // The person's retry: sent once more, under the same key.
        w.dispatcher.retry("a");
        await w.settle();
        expect(w.sent.map((s) => s.key)).toEqual(["a", "b", "a"]);
        await sends.answer(w.error(403, "forbidden"));
        expect(draftA(w)).toMatchObject({ status: "rejected", attempts: 1 });
        await w.advance(5 * 60_000);
        expect(w.sent).toHaveLength(3);
        expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
      } finally {
        finish(w);
      }
    });

  test("the person's retry, made offline, is not undone by a restart of the binding before it is acted on", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      fail(w, RECORD, 1, "quota");
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      w.online = false;
      w.dispatcher.retry("a");
      await w.settle();
      await interrupt(w);
      expect(sends.at).toHaveLength(1);
      w.goOnline();
      await w.settle();
      expect(sends.at).toHaveLength(2);
    } finally {
      finish(w);
    }
  });

  test("the retry lifts the hold it saw and no later one: a full disk met again by the retried send holds the draft again", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = fail(w, RECORD, 2, "quota");
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      w.dispatcher.retry("a");
      await w.settle();
      expect(sends.at).toHaveLength(2);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count).toBe(2);
      await w.advance(5 * 60_000);
      await interrupt(w);
      await w.advance(60_000);
      expect(sends.at).toHaveLength(2);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "storage_full",
      });
    } finally {
      finish(w);
    }
  });

  test("control: another binding (a new ownership) inherits no hold; what it owes is what the durable records say", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      fail(w, RECORD, 1, "quota");
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect(w.dispatcher.state.get()).toMatchObject({ cause: "storage_full" });
      w.dispatcher.stop();
      await w.settle();
      const other: SyncOwnership = {
        token: null,
        signal: new AbortController().signal,
      };
      w.dispatcher.start(other);
      await w.settle();
      expect(sends.at, "a full disk has no durable record").toHaveLength(2);
      expect(w.sent[1]?.key).toBe("a");
    } finally {
      finish(w);
    }
  });
});

describe("F-13b-1a: when the failure's counter cannot be written either, the stop is recorded where it can be", () => {
  test("the counter fails: a fallback marker stops the draft at once; one send; the restarted run shows the stop, durable across a reload", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const record = fail(w, RECORD, 1);
      const counter = fail(w, COUNTER, 1);
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect([record.count, counter.count]).toEqual([1, 1]);
      expect(streaks(w), "no streak is fabricated").toEqual({});
      expect(w.markers.inspect(w.service).operations).toContain("receipt:a");
      await w.advance(5 * 60_000);
      expect(sends.at).toHaveLength(1);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
      });
      w.reload();
      w.start();
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

  test("neither the counter nor the marker can be written: the page's memory holds the stop through restarts of the binding, and says so", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      fail(w, RECORD, 1);
      const counter = fail(w, COUNTER, 1);
      w.markerStorage.failWrites = true;
      await interrupt(w);
      await sends.answer(w.error(403, "forbidden"));
      expect(counter.count).toBe(1);
      await w.advance(5 * 60_000);
      await interrupt(w);
      await w.advance(60_000);
      expect(sends.at).toHaveLength(1);
      expect(w.dispatcher.state.get()).toEqual({
        kind: "stopped",
        cause: "local_storage",
        memoryOnly: true,
      });
    } finally {
      finish(w);
    }
  });
});

describe("F-13b-1a: a binding that ENDED settles nothing and counts nothing", () => {
  test("the binding ends while the answer is held: the record is never attempted, nothing is counted, the next owner sends the draft again under the same key", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = fail(w, RECORD, 1);
      w.dispatcher.stop();
      w.ownership.abort();
      await w.settle();
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count, "no record was attempted").toBe(0);
      expect(streaks(w)).toEqual({});
      expect(draftA(w)).toMatchObject({ status: "in_flight", attempts: 0 });
      const next: SyncOwnership = {
        token: null,
        signal: new AbortController().signal,
      };
      w.dispatcher.start(next);
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a", "a"]);
    } finally {
      finish(w);
    }
  });

  test("control: a stopped run's record that meets a CLOSED store is a drop (the commit's), counts nothing and shows nothing of the stopped run", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = fail(w, RECORD, 1, "closed");
      w.dispatcher.stop();
      await w.settle();
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count).toBe(1);
      expect(streaks(w)).toEqual({});
      expect(w.markers.inspect(w.service).operations).toEqual([]);
      expect(w.dispatcher.state.get()).toEqual({ kind: "not_started" });
    } finally {
      finish(w);
    }
  });

  test("the binding ends while its failed record is under way: the failure is not counted for it", async () => {
    const w = await world();
    try {
      const sends = await sentOnce(w);
      const hits = { count: 0 };
      w.env.idb.inject({
        match: (tx) => {
          if (tx.label !== RECORD || hits.count > 0) return false;
          hits.count += 1;
          // The binding ends between the admission of the answer and the delivery of its failed record.
          w.ownership.abort();
          return true;
        },
        mode: "error",
        times: 1,
      });
      w.dispatcher.stop();
      await w.settle();
      await sends.answer(w.error(403, "forbidden"));
      expect(hits.count).toBe(1);
      expect(streaks(w)).toEqual({});
      expect(w.markers.inspect(w.service).operations).toEqual([]);
      expect(draftA(w)).toMatchObject({ status: "in_flight", attempts: 0 });
    } finally {
      finish(w);
    }
  });
});

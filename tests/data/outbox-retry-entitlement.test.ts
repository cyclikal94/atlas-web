// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { QUEUE_OPERATION } from "../../src/data/model/retry";
import { recordLocalWriteOutcome } from "../../src/data/plans/retry-state";
import { createDataEnv } from "../../src/data/ui/env";
import {
  markerInstances,
  pageMarkers,
  plantMarker,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R53 (revision 32): the person's "Try again" ends the failures that stood when it was made, and no failure recorded after.
 *
 * The independent review of revision 31 saved drafts `a` and `b`, failed an edit and its counter write for each (two fallback stops),
 * asked to retry all, held the delivery of the first successful counter reset (`a`'s) after it committed, recorded NEWER failures of
 * `b` meanwhile (three durable ones, or a new marker whose reads then throw), and released the reset: the retry reached `b` and ended
 * the newer failure (the durable streak went to 0, or the newer marker was removed blind), the warning went down, and starting the
 * dispatcher sent BOTH original bodies; the newer failed body had been neither saved nor sent.
 *
 * The retry now carries what it was entitled to. The marker is ended by the exact key it saw; the durable streak is reset on the VERSION
 * of the failure the facade had seen when the person asked (`recordLocalWriteOutcome` with `expect`), and a version that is not that one
 * leaves the streak alone and says so. A failure recorded while the retry waits (on the database, on another operation, or on its own
 * transaction's admission) has a version of its own. The same holds for the dispatcher's retry and for the success of its queue read.
 *
 * FIXTURE evidence: the production facade, plans, dispatcher and markers over the double of IndexedDB and of `localStorage`; the delayed
 * delivery is injected after the commit, as the review injected it, and the other tab's failures are the production plan run by a
 * second writer. The native cases (real IndexedDB transactions that abort, a second real page) are E-O11.
 */
const request = (localId: string, label: string): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: `r-${localId}`,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  build: () => ({ command: { kind: "edit", id: `r-${localId}`, label } }),
});

const account = (w: OutboxWorld): string => w.service.account;

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r-a", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
  ]);
  w.reload({
    markers: pageMarkers(w.markerStorage),
  });
  await w.settle();
  return w;
}

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};

const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });

type RunStore = {
  run: (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
};
type Matcher = (plan: { name: string }, input: unknown) => boolean;

/** A reset of the durable failure state (the production plan with a `success` outcome), optionally of one operation. */
const reset =
  (operation?: string): Matcher =>
  (plan, input) => {
    const given = input as {
      operation?: string;
      outcome?: { kind: string };
    };
    return (
      plan.name === "data.recordLocalWriteOutcome" &&
      given.outcome?.kind === "success" &&
      (operation === undefined || given.operation === operation)
    );
  };

/**
 * Holds the DELIVERY of the answers that `matches` selects: each runs and COMMITS at once, and its caller is told when `release()` is
 * called, as the review did. `first` holds only the first such run.
 */
function holdAfterCommit(w: OutboxWorld, matches: Matcher, first = false) {
  const store = w.service.store as unknown as RunStore;
  const real = store.run.bind(store);
  let holding = true;
  let landed = 0;
  const pending: Array<() => void> = [];
  store.run = (plan, input, options) => {
    const answer = real(plan, input, options);
    if (!holding || !matches(plan, input)) return answer;
    if (first) holding = false;
    return new Promise((resolve, reject) => {
      answer.then((value) => {
        landed += 1;
        pending.push(() => resolve(value));
      }, reject);
    });
  };
  return {
    landed: () => landed,
    release: () => {
      holding = false;
      for (const deliver of pending.splice(0)) deliver();
    },
  };
}

/**
 * Holds the START of the runs that `matches` selects: the transaction is not submitted until `release()`, so whatever another writer
 * commits meanwhile is in the database before it is admitted (the reset's admission, or the cut's read).
 */
function holdBeforeStart(w: OutboxWorld, matches: Matcher, first = false) {
  const store = w.service.store as unknown as RunStore;
  const real = store.run.bind(store);
  let holding = true;
  let asked = 0;
  const pending: Array<() => void> = [];
  store.run = (plan, input, options) => {
    if (!holding || !matches(plan, input)) return real(plan, input, options);
    if (first) holding = false;
    asked += 1;
    return new Promise((resolve, reject) => {
      pending.push(() => {
        real(plan, input, options).then(resolve, reject);
      });
    });
  };
  return {
    asked: () => asked,
    release: () => {
      holding = false;
      for (const run of pending.splice(0)) run();
    },
  };
}

/** The production failure record, written by ANOTHER writer (a second tab's facade or dispatcher): `times` consecutive durable failures. */
async function otherTabFails(
  w: OutboxWorld,
  operation: string,
  times: number,
): Promise<number | null> {
  let version: number | null = null;
  for (let i = 0; i < times; i += 1) {
    const result = await w.service.store.run(recordLocalWriteOutcome, {
      incarnationId: w.service.incarnationId,
      operation,
      outcome: { kind: "failure" },
    });
    version = result.version;
  }
  return version;
}

const streak = (w: OutboxWorld, operation: string): number =>
  w.sync().local_write_streaks[operation] ?? 0;
const version = (w: OutboxWorld, operation: string): number | undefined =>
  w.sync().local_write_versions?.[operation];

/** A stop recorded only in the fallback marker: the edit fails and so does the recording of its failure. */
async function markerStop(w: OutboxWorld, id: string): Promise<void> {
  fail(w, "data.editQueuedDraft", 1);
  fail(w, "data.recordLocalWriteOutcome", 1);
  expect(
    (await w.outbox.editQueued(id, request(id, "first-failed"))).kind,
  ).toBe("refused");
}

async function twoStopped(w: OutboxWorld): Promise<void> {
  for (const id of ["a", "b"])
    expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
      "queued",
    );
  await w.settle();
  for (const id of ["a", "b"]) await markerStop(w, id);
  await w.settle();
  expect(w.outbox.storageNotResponding.get()).toBe(true);
}

async function runDispatcher(w: OutboxWorld): Promise<void> {
  w.start();
  w.goOnline();
  await w.settle();
  await w.advance(10_000);
}

const bodies = (w: OutboxWorld): string => w.sent.map((s) => s.body).join("|");

describe("R53: the review's schedule through the public facade (retry all, `a`'s reset held after it committed)", () => {
  for (const mechanism of [
    "durable",
    "marker-readable",
    "marker-unreadable",
  ] as const)
    for (const newer of [false, true])
      test(`draft b ${mechanism}, newer failure=${newer}: ${newer ? "only a is released; b stays stopped and its original body unsent" : "both are released (control)"}`, async () => {
        const w = await world();
        const hold = holdAfterCommit(w, reset(), true);
        try {
          await twoStopped(w);
          const olderB = markerInstances(
            w.markerStorage,
            account(w),
            "draft:b",
          );
          expect(olderB).toHaveLength(1);
          w.outbox.retry();
          await w.settle();
          // The premise: the first reset (a's) has committed and its result is held; the retry has not reached b.
          expect(hold.landed()).toBe(1);
          expect(
            markerInstances(w.markerStorage, account(w), "draft:b"),
          ).toEqual(olderB);
          if (newer) {
            const count = mechanism === "durable" ? 3 : 1;
            fail(w, "data.editQueuedDraft", count);
            if (mechanism !== "durable")
              fail(w, "data.recordLocalWriteOutcome", 1);
            for (let i = 0; i < count; i += 1)
              expect(
                (await w.outbox.editQueued("b", request("b", "newer-failed")))
                  .kind,
              ).toBe("refused");
            await w.settle();
            if (mechanism === "durable") expect(streak(w, "draft:b")).toBe(3);
          }
          const newerB = markerInstances(
            w.markerStorage,
            account(w),
            "draft:b",
          ).filter((name) => !olderB.includes(name));
          if (mechanism === "marker-unreadable") {
            // The reads throw before the earlier retry continues: the older retry must not turn that into permission.
            w.markerStorage.failEnumeration = true;
            w.markerStorage.failGets = true;
          }
          hold.release();
          await w.settle();
          w.markerStorage.failEnumeration = false;
          w.markerStorage.failGets = false;
          await w.settle();
          // The record: the older marker the act saw is gone (its exact key); a newer failure stands exactly as recorded.
          if (newer && mechanism !== "durable")
            expect(
              markerInstances(w.markerStorage, account(w), "draft:b"),
            ).toEqual(newerB);
          if (newer && mechanism === "durable")
            expect(streak(w, "draft:b")).toBe(3);
          expect(w.outbox.storageNotResponding.get()).toBe(newer);
          await runDispatcher(w);
          expect(w.sent.map((s) => s.key).sort()).toEqual(
            newer ? ["a"] : ["a", "b"],
          );
          // Nothing that was never saved was sent, and the older saved body of `b` is not sent behind its newer failure.
          expect(bodies(w)).not.toContain("newer-failed");
          expect(bodies(w)).not.toContain("first-failed");
          expect(w.outbox.storageNotResponding.get()).toBe(newer);
        } finally {
          hold.release();
          finish(w);
        }
      });

  test("the reversed order: b's reset is the one held, and a fails again after its own reset committed: a stays stopped, b goes", async () => {
    const w = await world();
    const hold = holdAfterCommit(w, reset("draft:b"), true);
    try {
      await twoStopped(w);
      w.outbox.retry();
      await w.settle();
      expect(hold.landed()).toBe(1);
      // `a`'s reset has been delivered and the facade has moved on to `b`: a failure of `a` NOW is newer than the person's decision.
      await otherTabFails(w, "draft:a", 3);
      hold.release();
      await w.settle();
      expect(streak(w, "draft:a")).toBe(3);
      expect(streak(w, "draft:b")).toBe(0);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["b"]);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      hold.release();
      finish(w);
    }
  });
});

describe("R53: the durable reset is conditional at every point the retry can wait", () => {
  test("a single-draft retry whose reset is not yet admitted: another tab's three failures arrive first and the reset leaves them", async () => {
    const w = await world();
    try {
      await twoStopped(w);
      const hold = holdBeforeStart(w, reset("draft:b"), true);
      w.outbox.retry("b");
      await w.settle();
      expect(hold.asked()).toBe(1);
      await otherTabFails(w, "draft:b", 3);
      expect(streak(w, "draft:b")).toBe(3);
      hold.release();
      await w.settle();
      expect(streak(w, "draft:b")).toBe(3);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      await runDispatcher(w);
      // `a` was not retried (its own marker stands), and `b`'s retry ended the older marker but not the newer streak.
      expect(w.sent).toHaveLength(0);
    } finally {
      finish(w);
    }
  });

  test("the retry's first read of the records is held: a failure recorded meanwhile is not the person's to end", async () => {
    const w = await world();
    try {
      await twoStopped(w);
      const hold = holdBeforeStart(
        w,
        (plan) => plan.name === "data.readLocalWriteStops",
        true,
      );
      w.outbox.retry();
      await w.settle();
      expect(hold.asked()).toBe(1);
      await otherTabFails(w, "draft:b", 3);
      hold.release();
      await w.settle();
      expect(streak(w, "draft:b")).toBe(3);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("a count equal to the one the retry saw is not the same failure: three failures, a reset, and three more are different (ABA)", async () => {
    const w = await world();
    try {
      for (const id of ["a"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      fail(w, "data.editQueuedDraft", 3);
      for (let i = 0; i < 3; i += 1)
        expect(
          (await w.outbox.editQueued("a", request("a", "failed"))).kind,
        ).toBe("refused");
      await w.settle();
      const seen = version(w, "draft:a");
      expect(streak(w, "draft:a")).toBe(3);
      const hold = holdBeforeStart(w, reset("draft:a"), true);
      w.outbox.retry();
      await w.settle();
      expect(hold.asked()).toBe(1);
      // Another tab recovers the draft and it fails three times again: the count is 3 again, and the failure is another.
      await w.service.store.run(recordLocalWriteOutcome, {
        incarnationId: w.service.incarnationId,
        operation: "draft:a",
        outcome: { kind: "success", expect: seen ?? null },
      });
      expect(streak(w, "draft:a")).toBe(0);
      await otherTabFails(w, "draft:a", 3);
      expect(streak(w, "draft:a")).toBe(3);
      expect(version(w, "draft:a")).not.toBe(seen);
      hold.release();
      await w.settle();
      expect(streak(w, "draft:a")).toBe(3);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("a failure that another tab recorded BEFORE the person asked, which this facade has not yet looked at, is not ended by that first retry; the retry made after a look does", async () => {
    const w = await world();
    try {
      for (const id of ["a"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      // The facade failed `a` once itself (below the bound) and saw it; another tab then fails it twice more, with no message.
      fail(w, "data.editQueuedDraft", 1);
      expect(
        (await w.outbox.editQueued("a", request("a", "failed"))).kind,
      ).toBe("refused");
      await w.settle();
      await otherTabFails(w, "draft:a", 2);
      expect(streak(w, "draft:a")).toBe(3);
      w.outbox.retry("a");
      await w.settle();
      // The facade's observation of the streak was the one of its own failure; the stop is a later episode. The first retry leaves it
      // and the warning shows it (the look at the end of the retry reads it); the retry made then has seen it and ends it.
      expect(streak(w, "draft:a")).toBe(3);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      w.outbox.retry("a");
      await w.settle();
      expect(streak(w, "draft:a")).toBe(0);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("a stop another tab recorded, which this facade has LOOKED at (it started after it), is ended by its retry", async () => {
    const w = await world();
    try {
      for (const id of ["a"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      await otherTabFails(w, "draft:a", 3);
      // The page loads again (a facade LOOKS at the records when it starts) and shows the stop another tab recorded.
      w.reload({
        markers: pageMarkers(w.markerStorage),
      });
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      w.outbox.retry("a");
      await w.settle();
      expect(streak(w, "draft:a")).toBe(0);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("control: nothing recorded meanwhile, a retry whose reset is held before its admission ends the durable stop it saw", async () => {
    const w = await world();
    try {
      for (const id of ["a"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      fail(w, "data.editQueuedDraft", 3);
      for (let i = 0; i < 3; i += 1)
        expect(
          (await w.outbox.editQueued("a", request("a", "failed"))).kind,
        ).toBe("refused");
      await w.settle();
      const hold = holdBeforeStart(w, reset("draft:a"), true);
      w.outbox.retry();
      await w.settle();
      hold.release();
      await w.settle();
      expect(streak(w, "draft:a")).toBe(0);
      expect(version(w, "draft:a")).toBeUndefined();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("a below-bound count the facade saw fail is ended by its retry, and one it did not see is not", async () => {
    const w = await world();
    try {
      for (const id of ["a", "b"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      fail(w, "data.editQueuedDraft", 2);
      for (let i = 0; i < 2; i += 1)
        expect(
          (await w.outbox.editQueued("a", request("a", "failed"))).kind,
        ).toBe("refused");
      await otherTabFails(w, "draft:b", 2);
      await w.settle();
      w.outbox.retry();
      await w.settle();
      expect(streak(w, "draft:a")).toBe(0);
      expect(streak(w, "draft:b")).toBe(2);
    } finally {
      finish(w);
    }
  });
});

describe("R53: the dispatcher's retry and the success of its queue read are conditional too", () => {
  test("the facade's retry composed with a RUNNING dispatcher, every reset held: a failure recorded meanwhile is left by both actors", async () => {
    const w = await world();
    try {
      for (const id of ["a", "b"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      // Both drafts are stopped durably (three failed edits each).
      fail(w, "data.editQueuedDraft", 6);
      for (const id of ["a", "b"])
        for (let i = 0; i < 3; i += 1)
          expect(
            (await w.outbox.editQueued(id, request(id, "failed"))).kind,
          ).toBe("refused");
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(2_000);
      expect(w.sent).toHaveLength(0);
      const holds = holdAfterCommit(w, reset());
      w.outbox.retry();
      await w.settle();
      expect(holds.landed()).toBeGreaterThan(0);
      await otherTabFails(w, "draft:b", 1);
      const newer = version(w, "draft:b");
      holds.release();
      await w.settle();
      await w.advance(10_000);
      expect(streak(w, "draft:a")).toBe(0);
      expect(streak(w, "draft:b")).toBe(4);
      expect(version(w, "draft:b")).toBe(newer);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("the dispatcher's own retry (no facade), made over the stops it read, leaves a failure of the draft it reaches last, recorded and READ while the first reset waits", async () => {
    const w = await world();
    try {
      for (const id of ["a", "b"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      fail(w, "data.editQueuedDraft", 6);
      for (const id of ["a", "b"])
        for (let i = 0; i < 3; i += 1)
          expect(
            (await w.outbox.editQueued(id, request(id, "failed"))).kind,
          ).toBe("refused");
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(2_000);
      expect(w.dispatcher.state.get()).toMatchObject({ kind: "stopped" });
      // The retry lifts `draft:a` first: that reset is the one that waits, and `draft:b` is reached after it.
      const hold = holdBeforeStart(w, reset("draft:a"), true);
      w.dispatcher.retry();
      await w.settle();
      expect(hold.asked()).toBe(1);
      await otherTabFails(w, "draft:b", 1);
      // The dispatcher steps while the retry waits and READS the newer failure: what it has seen now is the newer version, and the act's
      // entitlement is still the one it had when the person asked.
      w.dispatcher.wake();
      await w.settle();
      hold.release();
      await w.settle();
      await w.advance(10_000);
      expect(streak(w, "draft:b")).toBe(4);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("the success of the queue read ends the failure ITS snapshot showed, and a later one is left (D2)", async () => {
    const w = await world();
    try {
      // The dispatcher's earlier read failed once (a streak of 1 under `queue`).
      await otherTabFails(w, QUEUE_OPERATION, 1);
      w.online = true;
      const hold = holdAfterCommit(
        w,
        (plan) => plan.name === "data.readDispatchWindow",
        true,
      );
      w.start();
      await w.settle();
      expect(hold.landed()).toBe(1);
      // Another tab's dispatcher fails to read the queue three times while this read's answer is on its way.
      await otherTabFails(w, QUEUE_OPERATION, 3);
      const newer = version(w, QUEUE_OPERATION);
      hold.release();
      await w.settle();
      // The read's snapshot saw the first failure only: that one is ended, and the three newer ones are not.
      expect(streak(w, QUEUE_OPERATION)).toBe(4);
      expect(version(w, QUEUE_OPERATION)).toBe(newer);
      // Nothing is queued, so the dispatcher is idle; a read that is made after those failures and succeeds ends them.
      w.dispatcher.wake();
      await w.settle();
      expect(streak(w, QUEUE_OPERATION)).toBe(0);
    } finally {
      finish(w);
    }
  });

  test("control: a queue read that succeeds ends the failure it saw", async () => {
    const w = await world();
    try {
      await otherTabFails(w, QUEUE_OPERATION, 2);
      expect(streak(w, QUEUE_OPERATION)).toBe(2);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(streak(w, QUEUE_OPERATION)).toBe(0);
      expect(version(w, QUEUE_OPERATION)).toBeUndefined();
    } finally {
      finish(w);
    }
  });
});

describe("R53: the marker half of the same act (exact keys), with the same completion orders", () => {
  test("a marker another page records while the retry waits stands, whether or not it can be read afterwards, and its draft is not sent", async () => {
    for (const unreadable of [false, true]) {
      const w = await world();
      const hold = holdAfterCommit(w, reset(), true);
      try {
        await twoStopped(w);
        w.outbox.retry();
        await w.settle();
        expect(hold.landed()).toBe(1);
        const other = w.markerStorage.page("another-tab");
        plantMarker(other.storage, account(w), "draft:b", "tab.9");
        if (unreadable) w.markerStorage.failEnumeration = true;
        hold.release();
        await w.settle();
        w.markerStorage.failEnumeration = false;
        await w.settle();
        expect(markerInstances(w.markerStorage, account(w), "draft:b")).toEqual(
          ["tab.9"],
        );
        await runDispatcher(w);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(w.outbox.storageNotResponding.get()).toBe(true);
      } finally {
        hold.release();
        finish(w);
      }
    }
  });

  test("two retries made one after the other are separately scoped: the second ends what the first could not", async () => {
    const w = await world();
    const hold = holdAfterCommit(w, reset(), true);
    try {
      await twoStopped(w);
      w.outbox.retry();
      await w.settle();
      expect(hold.landed()).toBe(1);
      plantMarker(
        w.markerStorage.page("another-tab").storage,
        account(w),
        "draft:b",
        "tab.9",
      );
      hold.release();
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      // The person asks again, having seen the warning stay: this act's entitlement includes the newer marker.
      w.outbox.retry();
      await w.settle();
      expect(markerInstances(w.markerStorage, account(w), "draft:b")).toEqual(
        [],
      );
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
    } finally {
      hold.release();
      finish(w);
    }
  });
});

/** The production controller (`createDataEnv`) over the world: its own runtime and service, and markers of a page of its own over the same `localStorage`. */
async function controllerOver(w: OutboxWorld) {
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: unorderedPersistence,
    registry: w.page.registry,
    open: (account, options) => w.page.open(account, options),
  });
  const page = w.markerStorage.page("controller");
  const env = createDataEnv({
    identity: w.identity,
    loadRuntime: async () => runtime,
    online: { get: () => w.online, subscribe: () => () => undefined },
    quota: w.quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    markers: pageMarkers(page),
  });
  await w.settle();
  return env;
}

describe("R53 through the production controller (the composition a screen uses: `retryChanges`)", () => {
  for (const mechanism of ["marker", "durable"] as const)
    test(`the controller's retry of all drafts, \`a\`'s reset held: a ${mechanism} failure of \`b\` recorded meanwhile is not ended, and its warning stays`, async () => {
      const w = await world();
      const env = await controllerOver(w);
      try {
        const facade = env.outbox();
        if (facade === null)
          throw new Error("setup: the controller has no outbox");
        const service = env.service();
        if (service === null)
          throw new Error("setup: the controller has no service");
        for (const id of ["a", "b"])
          expect((await facade.enqueue(request(id, "original"))).kind).toBe(
            "queued",
          );
        await w.settle();
        for (const id of ["a", "b"]) {
          fail(w, "data.editQueuedDraft", 1);
          fail(w, "data.recordLocalWriteOutcome", 1);
          expect(
            (await facade.editQueued(id, request(id, "first-failed"))).kind,
          ).toBe("refused");
        }
        await w.settle();
        expect(env.inputs.get().storageNotResponding).toBe(true);
        const store = service.store as unknown as RunStore;
        const real = store.run.bind(store);
        let armed = true;
        let landed = false;
        let release = (): void => undefined;
        store.run = (plan, input, options) => {
          const answer = real(plan, input, options);
          if (!armed || !reset()(plan, input)) return answer;
          armed = false;
          return new Promise((resolve, reject) => {
            answer.then((value) => {
              landed = true;
              release = () => resolve(value);
            }, reject);
          });
        };
        env.actions.retryChanges();
        await w.settle();
        expect(landed).toBe(true);
        // `b` fails again while the retry waits: a failure newer than the person's decision.
        if (mechanism === "marker") {
          fail(w, "data.editQueuedDraft", 1);
          fail(w, "data.recordLocalWriteOutcome", 1);
          expect(
            (await facade.editQueued("b", request("b", "newer-failed"))).kind,
          ).toBe("refused");
        } else {
          fail(w, "data.editQueuedDraft", 3);
          for (let i = 0; i < 3; i += 1)
            expect(
              (await facade.editQueued("b", request("b", "newer-failed"))).kind,
            ).toBe("refused");
          expect(streak(w, "draft:b")).toBe(3);
        }
        await w.settle();
        release();
        await w.settle();
        expect(env.inputs.get().storageNotResponding).toBe(true);
        expect(markerInstances(w.markerStorage, account(w), "draft:a")).toEqual(
          [],
        );
        if (mechanism === "marker")
          expect(
            markerInstances(w.markerStorage, account(w), "draft:b"),
          ).toHaveLength(1);
        else expect(streak(w, "draft:b")).toBe(3);
      } finally {
        env.dispose();
        finish(w);
      }
    });
});

describe("R53 controls: a healthy retry, an abandonment, and an unrelated draft are as they were", () => {
  test("retry of one draft lifts that draft only, even when both are stopped by markers", async () => {
    const w = await world();
    try {
      await twoStopped(w);
      w.outbox.retry("a");
      await w.settle();
      expect(markerInstances(w.markerStorage, account(w), "draft:a")).toEqual(
        [],
      );
      expect(
        markerInstances(w.markerStorage, account(w), "draft:b"),
      ).toHaveLength(1);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  test("abandoning a stopped draft ends its stops and leaves the other draft's", async () => {
    const w = await world();
    try {
      await twoStopped(w);
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      expect(markerInstances(w.markerStorage, account(w), "draft:a")).toEqual(
        [],
      );
      expect(
        markerInstances(w.markerStorage, account(w), "draft:b"),
      ).toHaveLength(1);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("a healthy retry of a durable stop ends it, resets the version, and the draft is sent once", async () => {
    const w = await world();
    try {
      for (const id of ["a"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      fail(w, "data.editQueuedDraft", 3);
      for (let i = 0; i < 3; i += 1)
        expect(
          (await w.outbox.editQueued("a", request("a", "failed"))).kind,
        ).toBe("refused");
      await w.settle();
      expect(w.sync().local_write_versions?.["draft:a"]).toBeGreaterThan(0);
      w.outbox.retry();
      await w.settle();
      expect(streak(w, "draft:a")).toBe(0);
      expect(w.sync().local_write_versions ?? {}).toEqual({});
      await runDispatcher(w);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });
});

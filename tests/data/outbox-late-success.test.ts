// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { deriveNotices } from "../../src/data/model/status";
import type { DraftRow } from "../../src/data/model/types";
import { createDataEnv } from "../../src/data/ui/env";
import {
  markerInstances,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";

/**
 * R50 (revision 31): an earlier successful write, whose result is delivered LATE, cannot end a NEWER stop of the same operation.
 *
 * The independent review of revision 30 saved a draft, committed an edit (`older-success`) and held the delivery of its result, made a
 * second edit fail (the failure's own counter failed too, so the stop was a marker, or, with the marker unwritable, the page's memory),
 * released the older result, and started the dispatcher: the facade's cleanup after the awaited transaction removed the newer stop, the
 * warning disappeared and the dispatcher sent the OLDER body (a sibling failure of revision 29's R47). The same holds through every
 * caller of the facade's `ended()` (enqueue, edit, discard, supersede), through the dispatcher's own `succeeded()` (a receipt written
 * late) and `clearStreak()` (the queue read), and when the newer stop is another page's. A success ends the instances that stood when
 * it was ISSUED, however late its result is delivered; a stop recorded after that is a newer failure that it did not recover.
 *
 * What is NOT claimed: that the newer, unsaved body was saved or sent (it was neither), or that the failed edit is retried. The draft
 * stays as the last transaction that landed left it, stopped, until the person's retry.
 *
 * FIXTURE evidence: the production facade, plans, dispatcher and markers over the double of IndexedDB and of `localStorage`; the
 * delayed delivery is injected (the transaction commits, its answer is held), as the review injected it. The native cases (a second
 * real page, real IndexedDB transactions that abort, the real `localStorage`) are E-O10.
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
/**
 * The markers that stand for the operation, as one string (the sorted names of their keys), or undefined when none does. ADAPTED,
 * revision 32 (R52): a failure is a key of its own, so what a case compares is the instances that stand, not one shared value.
 */
const marker = (w: OutboxWorld, operation: string): string | undefined => {
  const names = markerInstances(w.markerStorage, account(w), operation);
  return names.length === 0 ? undefined : names.join(",");
};
const fail = (w: OutboxWorld, label: string, times: number): void => {
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
};

/** The page's markers listen to the storage of the other pages, as a production page's do. */
async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.reload({
    markers: pageMarkers(w.markerStorage),
  });
  await w.settle();
  return w;
}

/** Another page of the same origin: its own markers over the same `localStorage`. */
const anotherPage = (w: OutboxWorld) => {
  const page = w.markerStorage.page("another-page");
  return pageMarkers(page);
};

/**
 * Holds the DELIVERY of the answer of the next run of `planName` (it runs at once over the real database and commits; the caller is
 * told only when `release` is called), as the review did.
 */
function holdResult(w: OutboxWorld, planName: string) {
  return holdResultOn(w.service.store, planName);
}

type RunStore = {
  run: (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
};

/** `holdResult` on a given store (the controller's own service has one of its own). */
function holdResultOn(runStore: unknown, planName: string) {
  const store = runStore as RunStore;
  const real = store.run.bind(store);
  let armed = true;
  let landed = false;
  let release = (): void => undefined;
  store.run = (plan, input, options) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== planName) return answer;
    armed = false;
    return new Promise((resolve, reject) => {
      answer.then((value) => {
        landed = true;
        release = () => resolve(value);
      }, reject);
    });
  };
  return {
    landed: () => landed,
    release: () => release(),
    restore: () => {
      store.run = real;
    },
  };
}

/**
 * Holds the delivery of EVERY run of `planName` from now until `release()`: each runs and commits at once, and its caller is told when
 * `release` is called (a retry that waits on the database for each operation it lifts, with both of its actors stopped at their first write).
 */
function holdEvery(w: OutboxWorld, planName: string) {
  const store = w.service.store as unknown as RunStore;
  const real = store.run.bind(store);
  let holding = true;
  let landed = 0;
  const pending: Array<() => void> = [];
  store.run = (plan, input, options) => {
    const answer = real(plan, input, options);
    if (!holding || plan.name !== planName) return answer;
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

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};

type Older = "edit" | "enqueue" | "discard" | "supersede";
type Stop = "marker" | "memory" | "durable" | "another page";
const OLDER: Older[] = ["edit", "enqueue", "discard", "supersede"];
const STOPS: Stop[] = ["marker", "memory", "durable", "another page"];

const PLAN: Record<Older, string> = {
  edit: "data.editQueuedDraft",
  enqueue: "data.enqueueDraft",
  discard: "data.discardDraft",
  supersede: "data.supersedeDraft",
};

/** The older write, issued (its transaction commits) and, when `delayed`, its result held. The draft whose operation the stop is about. */
async function olderWrite(
  w: OutboxWorld,
  older: Older,
  delayed: boolean,
): Promise<{
  done: () => Promise<string>;
  draft: string;
  release: () => void;
}> {
  if (older !== "enqueue")
    expect((await w.outbox.enqueue(request("a", "initial"))).kind).toBe(
      "queued",
    );
  await w.settle();
  // Only a draft in a version conflict can be superseded.
  if (older === "supersede")
    w.put("drafts", [
      {
        ...(w.drafts().find((d) => d.local_id === "a") as DraftRow),
        status: "version_conflict",
      },
    ]);
  const hold = delayed ? holdResult(w, PLAN[older]) : null;
  const promise: Promise<string> = (async () => {
    if (older === "edit")
      return (await w.outbox.editQueued("a", request("a", "older-success")))
        .kind;
    if (older === "enqueue")
      return (await w.outbox.enqueue(request("a", "older-success"))).kind;
    if (older === "discard") return (await w.outbox.discard("a")).kind;
    return (await w.outbox.supersede("a", request("a2", "older-success"))).kind;
  })();
  await w.settle();
  if (hold !== null) expect(hold.landed()).toBe(true);
  return {
    // The operation a newer failure is about: the replacement's for a supersession.
    draft: older === "supersede" ? "a2" : "a",
    done: () => promise,
    release: () => hold?.release(),
  };
}

/** The newer failure of the operation, recorded by `stop` AFTER the older write was issued. */
async function newerStop(
  w: OutboxWorld,
  draft: string,
  stop: Stop,
): Promise<void> {
  const operation = `draft:${draft}`;
  if (stop === "another page") {
    anotherPage(w).set(scopeOf(account(w)), operation);
    await w.settle();
    expect(marker(w, operation)).toBeDefined();
    return;
  }
  const times = stop === "durable" ? 3 : 1;
  fail(w, "data.editQueuedDraft", times);
  if (stop !== "durable") fail(w, "data.recordLocalWriteOutcome", 1);
  if (stop === "memory") w.markerStorage.failWrites = true;
  for (let i = 0; i < times; i += 1)
    expect(
      (await w.outbox.editQueued(draft, request(draft, "newer-failed"))).kind,
    ).toBe("refused");
  await w.settle();
}

/** The instances that stand now and did not stand before (`before`, taken earlier from `markerInstances`), as `marker` would show them. */
const newerThan = (
  w: OutboxWorld,
  operation: string,
  before: readonly string[],
): string | undefined => {
  const names = markerInstances(w.markerStorage, account(w), operation).filter(
    (name) => !before.includes(name),
  );
  return names.length === 0 ? undefined : names.join(",");
};

const standing = (w: OutboxWorld, operation: string) => ({
  marker: marker(w, operation),
  memory: w.markers.stops.has(w.service, operation),
  streak: w.sync().local_write_streaks[operation] ?? 0,
});

describe("R50: an older successful write delivered after a newer stop of the same operation", () => {
  for (const older of OLDER)
    for (const stop of STOPS)
      for (const delayed of [false, true]) {
        test(`${older}: a newer ${stop} stop, the older result ${delayed ? "delivered late" : "delivered in time (control)"}: the stop stands, the warning stays, nothing is sent`, async () => {
          const w = await world();
          try {
            const write = await olderWrite(w, older, delayed);
            const operation = `draft:${write.draft}`;
            await newerStop(w, write.draft, stop);
            expect(w.outbox.storageNotResponding.get()).toBe(true);
            const before = standing(w, operation);
            if (stop === "marker" || stop === "another page")
              expect(before.marker).toBeDefined();
            if (stop === "memory") expect(before.memory).toBe(true);
            if (stop === "durable") expect(before.streak).toBe(3);
            write.release();
            expect(["edited", "queued", "discarded", "superseded"]).toContain(
              await write.done(),
            );
            await w.settle();
            // The newer stop is EXACTLY as it was recorded: the same instance, in the same record.
            expect(standing(w, operation)).toEqual(before);
            expect(w.outbox.storageNotResponding.get()).toBe(true);
            // The dispatcher starts: the draft whose newer save failed is not sent (and no earlier completion has lifted its stop).
            w.online = true;
            w.start();
            await w.settle();
            await w.advance(10_000);
            expect(w.sent).toHaveLength(0);
            expect(standing(w, operation)).toEqual(before);
            expect(w.outbox.storageNotResponding.get()).toBe(true);
          } finally {
            finish(w);
          }
        });
      }

  test("control: the person's retry still lifts the newer stop, and the draft is sent once, as the last transaction that landed left it", async () => {
    const w = await world();
    try {
      const write = await olderWrite(w, "edit", true);
      await newerStop(w, "a", "marker");
      write.release();
      await write.done();
      await w.settle();
      w.outbox.retry("a");
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      // The older body is what was saved: the newer, unsaved one was neither saved nor sent.
      expect(w.sent[0]?.body).toContain("older-success");
      expect(w.sent[0]?.body).not.toContain("newer-failed");
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });
});

describe("R50 controls: a success still ends the stop it could have recovered", () => {
  for (const older of ["edit", "enqueue"] as const)
    for (const stop of ["marker", "memory", "another page"] as const)
      for (const delayed of [false, true])
        test(`${older}: a ${stop} stop recorded BEFORE the write was issued is ended by its success, ${delayed ? "even when the result is delivered late" : "in time"}; the draft is sent once, as saved`, async () => {
          const w = await world();
          try {
            if (older === "enqueue") {
              // The first save of the draft fails, and so does the recording of the failure: the stop is the marker or the memory.
              if (stop === "another page")
                anotherPage(w).set(scopeOf(account(w)), "draft:a");
              else {
                fail(w, "data.enqueueDraft", 1);
                fail(w, "data.recordLocalWriteOutcome", 1);
                if (stop === "memory") w.markerStorage.failWrites = true;
                expect(
                  (await w.outbox.enqueue(request("a", "unsaved"))).kind,
                ).toBe("refused");
              }
            } else {
              expect(
                (await w.outbox.enqueue(request("a", "initial"))).kind,
              ).toBe("queued");
              await w.settle();
              if (stop === "another page")
                anotherPage(w).set(scopeOf(account(w)), "draft:a");
              else {
                fail(w, "data.editQueuedDraft", 1);
                fail(w, "data.recordLocalWriteOutcome", 1);
                if (stop === "memory") w.markerStorage.failWrites = true;
                expect(
                  (await w.outbox.editQueued("a", request("a", "unsaved")))
                    .kind,
                ).toBe("refused");
              }
            }
            await w.settle();
            expect(w.outbox.storageNotResponding.get()).toBe(true);
            // The stop is out of the way for the write that follows (the store accepts a marker again).
            w.markerStorage.failWrites = false;
            const hold = delayed
              ? holdResult(
                  w,
                  older === "enqueue"
                    ? "data.enqueueDraft"
                    : "data.editQueuedDraft",
                )
              : null;
            const done =
              older === "enqueue"
                ? w.outbox.enqueue(request("a", "saved"))
                : w.outbox.editQueued("a", request("a", "saved"));
            await w.settle();
            if (hold !== null) {
              expect(hold.landed()).toBe(true);
              // Held: nothing has ended the stop yet.
              expect(w.outbox.storageNotResponding.get()).toBe(true);
              hold.release();
            }
            expect(["edited", "queued"]).toContain((await done).kind);
            await w.settle();
            expect(marker(w, "draft:a")).toBeUndefined();
            expect(w.markers.stops.has(w.service, "draft:a")).toBe(false);
            expect(w.outbox.storageNotResponding.get()).toBe(false);
            w.online = true;
            w.start();
            await w.settle();
            await w.advance(10_000);
            expect(w.sent.map((s) => s.key)).toEqual(["a"]);
            expect(w.sent[0]?.body).toContain("saved");
          } finally {
            finish(w);
          }
        });

  test("a durable streak is ended by the success's own transaction, however late the result is delivered", async () => {
    const w = await world();
    try {
      expect((await w.outbox.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      fail(w, "data.editQueuedDraft", 3);
      for (let i = 0; i < 3; i += 1)
        expect((await w.outbox.editQueued("a", request("a", "x"))).kind).toBe(
          "refused",
        );
      await w.settle();
      expect(w.sync().local_write_streaks["draft:a"]).toBe(3);
      const hold = holdResult(w, "data.editQueuedDraft");
      const done = w.outbox.editQueued("a", request("a", "saved"));
      await w.settle();
      expect(hold.landed()).toBe(true);
      expect(w.sync().local_write_streaks["draft:a"]).toBeUndefined();
      hold.release();
      expect((await done).kind).toBe("edited");
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });

  test("another operation's stops are not touched by a late success (isolation), and its recovery is not prevented by them", async () => {
    const w = await world();
    try {
      expect((await w.outbox.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      expect((await w.outbox.enqueue(request("b", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      // `b` is stopped by a marker and by the page's memory of a hold; `a` by a marker.
      anotherPage(w).set(scopeOf(account(w)), "draft:b");
      w.markers.stops.hold(w.service, "draft:b");
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      await w.settle();
      const before = standing(w, "draft:b");
      const hold = holdResult(w, "data.editQueuedDraft");
      const done = w.outbox.editQueued("a", request("a", "saved"));
      await w.settle();
      // A newer stop of `b` while `a`'s result is held.
      anotherPage(w).set(scopeOf(account(w)), "draft:b");
      const newer = standing(w, "draft:b");
      expect(newer.marker).not.toBe(before.marker);
      hold.release();
      expect((await done).kind).toBe("edited");
      await w.settle();
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(standing(w, "draft:b")).toEqual(newer);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("an abandoned draft's own stop ends with it even when the marker could not be read, and a stop of the replacement's own is kept", async () => {
    const w = await world();
    try {
      expect((await w.outbox.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      await w.settle();
      w.markerStorage.failGets = true;
      w.markerStorage.failEnumeration = true;
      w.reload({
        markers: pageMarkers(w.markerStorage),
      });
      expect((await w.outbox.discard("a")).kind).toBe("discarded");
      await w.settle();
      // ADAPTED, revision 32 (R52): a key that names its failure cannot be removed without naming it, and a discard issued when nothing
      // could be listed names nothing. The draft is gone; its stale marker stands (it protects nothing, and nothing can be sent for the
      // draft) until a listing lands and the person's retry names and ends it. It is not removed blind: a listing made later could name a
      // failure that is newer than the discard.
      expect(marker(w, "draft:a")).toBeDefined();
      expect(w.drafts()).toHaveLength(0);
      w.markerStorage.failGets = false;
      w.markerStorage.failEnumeration = false;
      await w.settle();
      w.outbox.retry();
      await w.settle();
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });
});

describe("R50: the facade's notes of its own failures", () => {
  test("a counted failure recorded after the write was issued is not forgotten when the late result arrives: the person's retry still clears its count below the bound", async () => {
    const w = await world();
    try {
      expect((await w.outbox.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      const hold = holdResult(w, "data.editQueuedDraft");
      const older = w.outbox.editQueued("a", request("a", "older-success"));
      await w.settle();
      expect(hold.landed()).toBe(true);
      // A NEWER failure of the same operation, counted (the counter works): one of three, no stop.
      fail(w, "data.editQueuedDraft", 1);
      expect(
        (await w.outbox.editQueued("a", request("a", "newer-failed"))).kind,
      ).toBe("refused");
      await w.settle();
      expect(w.sync().local_write_streaks["draft:a"]).toBe(1);
      hold.release();
      expect((await older).kind).toBe("edited");
      await w.settle();
      // The older success did not end the newer count, and the facade still knows that the draft failed since...
      expect(w.sync().local_write_streaks["draft:a"]).toBe(1);
      // ...so the person's retry reaches a count that is below the bound.
      w.outbox.retry("a");
      await w.settle();
      expect(w.sync().local_write_streaks["draft:a"]).toBeUndefined();
    } finally {
      finish(w);
    }
  });
});

describe("R50 through the production controller's own composition (`createDataEnv`, its markers shared by its facade)", () => {
  test("an older edit delivered late does not end a newer stop that another page recorded, and the notice a person reads stays", async () => {
    const w = await world();
    const env = await controllerOver(w);
    try {
      const facade = env.outbox();
      if (facade === null)
        throw new Error("setup: the controller has no outbox");
      expect((await facade.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      const service = env.service();
      if (service === null)
        throw new Error("setup: the controller has no service");
      const hold = holdResultOn(service.store, "data.editQueuedDraft");
      const older = facade.editQueued("a", request("a", "older-success"));
      await w.settle();
      expect(hold.landed()).toBe(true);
      // Another page records a NEWER stop of the same operation; its `storage` event reaches the controller's markers.
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      const newer = marker(w, "draft:a");
      await w.settle();
      const notices = () =>
        deriveNotices(env.inputs.get()).filter(
          (notice) => notice.kind === "storage_not_responding",
        );
      expect(notices()).toHaveLength(1);
      hold.release();
      expect((await older).kind).toBe("edited");
      await w.settle();
      expect(marker(w, "draft:a")).toBe(newer);
      expect(env.inputs.get().storageNotResponding).toBe(true);
      expect(notices()).toHaveLength(1);
    } finally {
      env.dispose();
      finish(w);
    }
  });

  test("control: the same write with nothing newer recorded ends the stop that stood when it was issued, and the notice goes", async () => {
    const w = await world();
    const env = await controllerOver(w);
    try {
      const facade = env.outbox();
      if (facade === null)
        throw new Error("setup: the controller has no outbox");
      expect((await facade.enqueue(request("a", "initial"))).kind).toBe(
        "queued",
      );
      await w.settle();
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      await w.settle();
      const service = env.service();
      if (service === null)
        throw new Error("setup: the controller has no service");
      const hold = holdResultOn(service.store, "data.editQueuedDraft");
      const saved = facade.editQueued("a", request("a", "saved"));
      await w.settle();
      expect(hold.landed()).toBe(true);
      expect(env.inputs.get().storageNotResponding).toBe(true);
      hold.release();
      expect((await saved).kind).toBe("edited");
      await w.settle();
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(env.inputs.get().storageNotResponding).toBe(false);
    } finally {
      env.dispose();
      finish(w);
    }
  });
});

describe("R50: the dispatcher's own successes (`succeeded`, `clearStreak`) end what stood when they were issued", () => {
  async function sendable(w: OutboxWorld): Promise<void> {
    expect((await w.outbox.enqueue(request("a", "original"))).kind).toBe(
      "queued",
    );
    await w.settle();
  }

  type Write = "admitted" | "rejected" | "failed";
  /** The server's answer, given once `gate` is open (the request stays in flight until then). */
  const WRITE: Record<
    Write,
    { plan: string; answer: (w: OutboxWorld, gate: Promise<void>) => void }
  > = {
    admitted: {
      plan: "data.admitReceipt",
      answer: (w, gate) =>
        w.script.push(async () => {
          await gate;
          return w.receipt();
        }),
    },
    rejected: {
      plan: "data.recordOutcome",
      answer: (w, gate) =>
        w.script.push(async () => {
          await gate;
          return w.error(422, "validation_failed");
        }),
    },
    failed: {
      plan: "data.recordFailureOfSend",
      answer: (w, gate) =>
        w.script.push(async () => {
          await gate;
          return new Error("network");
        }),
    },
  };
  const opened = (): { gate: Promise<void>; open: () => void } => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { gate, open };
  };

  for (const write of Object.keys(WRITE) as Write[])
    for (const newer of ["marker", "memory", "another page"] as const) {
      test(`the receipt of a draft whose answer is ${write}, recorded late: a newer ${newer} stop of the receipt's operation recorded while its result is held is not ended`, async () => {
        const w = await world();
        try {
          await sendable(w);
          const request_ = opened();
          WRITE[write].answer(w, request_.gate);
          const hold = holdResult(w, WRITE[write].plan);
          w.online = true;
          w.start();
          await w.settle();
          request_.open();
          await w.settle();
          expect(hold.landed()).toBe(true);
          const operation = "receipt:a";
          if (newer === "memory") w.markers.stops.hold(w.service, operation);
          else if (newer === "marker")
            w.markers.set(scopeOf(account(w)), operation);
          else anotherPage(w).set(scopeOf(account(w)), operation);
          const before = standing(w, operation);
          expect(before.marker !== undefined || before.memory).toBe(true);
          hold.release();
          await w.settle();
          expect(standing(w, operation)).toEqual(before);
        } finally {
          finish(w);
        }
      });
    }

  for (const write of Object.keys(WRITE) as Write[])
    for (const delayed of [false, true])
      test(`control: a receipt stop recorded while the request is in flight, before the write of an ${write} answer is issued, is ended by that write${delayed ? ", delivered late" : ""}`, async () => {
        const w = await world();
        try {
          await sendable(w);
          const request_ = opened();
          WRITE[write].answer(w, request_.gate);
          w.online = true;
          w.start();
          await w.settle();
          expect(w.sent).toHaveLength(1);
          // Another page records a stop of the receipt while the answer is awaited; the write that records the answer is issued after it.
          anotherPage(w).set(scopeOf(account(w)), "receipt:a");
          const hold = delayed ? holdResult(w, WRITE[write].plan) : null;
          request_.open();
          await w.settle();
          if (hold !== null) {
            expect(hold.landed()).toBe(true);
            expect(marker(w, "receipt:a")).toBeDefined();
            hold.release();
            await w.settle();
          }
          expect(marker(w, "receipt:a")).toBeUndefined();
        } finally {
          finish(w);
        }
      });

  test("the queue read: a stop of reading the queue that stood when the read was issued is ended by it; one recorded while the answer is held is not, and the next read that is issued after it ends it", async () => {
    const w = await world();
    try {
      await sendable(w);
      // A stale stop of the queue read (another page's), standing when the first read is issued.
      anotherPage(w).set(scopeOf(account(w)), "queue");
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(marker(w, "queue")).toBeUndefined();
      // A second read, whose answer is held; a NEWER stop of the queue read is recorded meanwhile.
      const hold = holdResult(w, "data.readDispatchWindow");
      w.outbox.retry();
      await w.settle();
      w.fire();
      await w.settle();
      // The read ran and committed, and its answer is held (the premise: asserted, never presumed).
      expect(hold.landed()).toBe(true);
      anotherPage(w).set(scopeOf(account(w)), "queue");
      const newer = marker(w, "queue");
      hold.release();
      await w.settle();
      expect(marker(w, "queue")).toBe(newer);
      // The next read is issued after that stop, and it ends it.
      w.fire();
      await w.settle();
      await w.advance(10_000);
      expect(marker(w, "queue")).toBeUndefined();
    } finally {
      finish(w);
    }
  });
});

describe("R50: the person's retry lifts what stood when it began, and not a stop recorded while it is under way", () => {
  for (const mechanism of ["marker", "memory"] as const)
    test(`a retry of all drafts, held on the database, does not lift a newer ${mechanism} stop of the draft it reaches last`, async () => {
      const w = await world();
      try {
        for (const id of ["a", "b"])
          expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
            "queued",
          );
        await w.settle();
        // Both drafts are stopped when the person asks.
        anotherPage(w).set(scopeOf(account(w)), "draft:a");
        anotherPage(w).set(scopeOf(account(w)), "draft:b");
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        // The retry waits on the database for each operation it lifts; the first of those is held.
        const hold = holdResult(w, "data.recordLocalWriteOutcome");
        w.outbox.retry();
        await w.settle();
        expect(hold.landed()).toBe(true);
        // While it is held, `draft:b` fails again: a NEWER stop than the person's decision.
        const olderB = markerInstances(w.markerStorage, account(w), "draft:b");
        if (mechanism === "memory") {
          w.markers.stops.hold(w.service, "draft:b");
          w.markerStorage.failWrites = true;
        } else anotherPage(w).set(scopeOf(account(w)), "draft:b");
        // ADAPTED, revision 32: the older marker the act did lift is gone (its exact key), so what must stand is the newer instance ALONE.
        const newer = {
          ...standing(w, "draft:b"),
          marker: newerThan(w, "draft:b", olderB),
        };
        hold.release();
        await w.settle();
        await w.advance(10_000);
        // The operation that stood when the act began is lifted; the newer stop of the other is exactly as recorded (when the newer
        // stop is a hold in the page's memory, the older marker that the act did lift is gone, and the hold stands).
        expect(marker(w, "draft:a")).toBeUndefined();
        if (mechanism === "memory") {
          expect(marker(w, "draft:b")).toBeUndefined();
          expect(w.markers.stops.has(w.service, "draft:b")).toBe(true);
        } else expect(standing(w, "draft:b")).toEqual(newer);
        expect(w.outbox.storageNotResponding.get()).toBe(true);
      } finally {
        finish(w);
      }
    });

  test("a retry of all drafts with the DISPATCHER running, every write of the retry held on the database: both actors lift what stood when it began, and not a stop recorded meanwhile", async () => {
    const w = await world();
    try {
      for (const id of ["a", "b"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      anotherPage(w).set(scopeOf(account(w)), "draft:b");
      await w.settle();
      // The dispatcher steps, finds both drafts stopped and stalls them: it knows them before the retry.
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(2_000);
      expect(w.sent).toHaveLength(0);
      expect(w.dispatcher.state.get()).toMatchObject({ kind: "stopped" });
      const hold = holdEvery(w, "data.recordLocalWriteOutcome");
      w.outbox.retry();
      await w.settle();
      // Premise: the retry is waiting on the database (both actors began, and each is held at its first write).
      expect(hold.landed()).toBeGreaterThan(0);
      const olderB = markerInstances(w.markerStorage, account(w), "draft:b");
      anotherPage(w).set(scopeOf(account(w)), "draft:b");
      // ADAPTED, revision 32: the older marker both actors lift is gone (its exact key), so what must stand is the newer instance alone.
      const newer = newerThan(w, "draft:b", olderB);
      expect(newer).toBeDefined();
      hold.release();
      await w.settle();
      await w.advance(10_000);
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(marker(w, "draft:b")).toBe(newer);
      // `a` was lifted and goes; `b` stands behind its newer stop.
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
    } finally {
      finish(w);
    }
  });

  test("control: nothing recorded meanwhile, the retry lifts both drafts and they are sent", async () => {
    const w = await world();
    try {
      for (const id of ["a", "b"])
        expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
          "queued",
        );
      await w.settle();
      anotherPage(w).set(scopeOf(account(w)), "draft:a");
      anotherPage(w).set(scopeOf(account(w)), "draft:b");
      await w.settle();
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent).toHaveLength(0);
      w.outbox.retry();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
      expect(marker(w, "draft:a")).toBeUndefined();
      expect(marker(w, "draft:b")).toBeUndefined();
      expect(w.outbox.storageNotResponding.get()).toBe(false);
    } finally {
      finish(w);
    }
  });
});

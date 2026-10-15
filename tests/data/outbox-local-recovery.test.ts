// @vitest-environment node
import { describe, expect, test } from "vitest";
import { unorderedPersistence } from "../../src/data/engine/account-service";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import {
  draftOperations,
  initialReadRetry,
  onReadFailure,
  operationDraft,
} from "../../src/data/model/retry";
import { deriveNotices } from "../../src/data/model/status";
import { createDataEnv } from "../../src/data/ui/env";
import { pageMarkers, scopeOf } from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { NAME } from "../support/data/page-world";
import { cacheRow } from "../support/data/rows";

/**
 * R46 and R47 (revision 26): the failure state of a local write ends with that write's OWN success or its explicit abandonment, and
 * the storage warning is the sum of every stop that still stands.
 *
 * R46: the success of an operation (a save, its edit, its supersession, its discard, the dispatcher's claim, its receipt writes, its
 * read of the queue) ended its failure streak only if THIS page had seen it fail, and `discard` and `supersede` never did. So after a
 * reload a successful retry left the durable count or the marker standing and the dispatcher stopped the saved draft, and three
 * isolated aborts between successes were "three in a row". The success now ends the streak in the SAME transaction as the write, and
 * the marker and the memory with it, whoever saw the failure.
 *
 * R47: "Try again" for one draft took the shared warning down although another draft was still stopped, and matched operations by
 * the END of the string (`draft:ba` answered to `a`). The warning is derived from the record, the markers and the memory, and an
 * operation is matched by the exact id it names.
 *
 * FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage`; no backend.
 */
const create = (localId: string): EnqueueRequest => ({
  localId,
  endpoint: "/commands",
  targets: [
    {
      resourceId: `res-${localId}`,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  build: () => ({
    command: { kind: "create", id: `res-${localId}` },
    displayPatch: { [`res-${localId}`]: { label: localId } },
  }),
});
/** An edit of the cached resource `r`: the supersession arrangements need a base. */
const edit = (localId: string, target = "r"): EnqueueRequest => ({
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

const PLAN = {
  enqueue: "data.enqueueDraft",
  editQueued: "data.editQueuedDraft",
  supersede: "data.supersedeDraft",
  discard: "data.discardDraft",
} as const;
type Method = keyof typeof PLAN;
const METHODS = Object.keys(PLAN) as Method[];
const DONE = {
  enqueue: "queued",
  editQueued: "edited",
  supersede: "superseded",
  discard: "discarded",
} as const;

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const account = (w: OutboxWorld): string => w.service.account;
const markersOf = (w: OutboxWorld): string[] =>
  w.markers.operations(scopeOf(account(w))).sort();
const streaksOf = (w: OutboxWorld): Record<string, number> =>
  w.sync().local_write_streaks;
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
/** The write that records a failure cannot be written either: the stop is immediate and goes to the marker. */
const failCounter = (w: OutboxWorld, times = 1) =>
  fail(w, "data.recordLocalWriteOutcome", times);

/**
 * The plan named `name` runs at once, against the store as it is, and its ANSWER is delivered when `release()` is called: a read that
 * was made before a write and is told of afterwards.
 */
function delayResult(
  store: OutboxWorld["service"]["store"],
  name: string,
): { release(): void } {
  const real = store.run.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let armed = true;
  let release: () => void = () => undefined;
  (store as { run: unknown }).run = (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== name) return answer;
    armed = false;
    return new Promise<unknown>((resolve, reject) => {
      release = () => {
        void answer.then(resolve, reject);
      };
    });
  };
  return { release: () => release() };
}

// ---- the identity of an operation (R47) ------------------------------------------------------------------------------------------
describe("R47: an operation is matched by the exact id it names", () => {
  test("`draft:<id>` and `receipt:<id>` name their id, and nothing else names a draft", () => {
    expect(operationDraft("draft:a")).toBe("a");
    expect(operationDraft("receipt:a")).toBe("a");
    expect(operationDraft("draft:ba")).toBe("ba");
    expect(operationDraft("draft:x:a")).toBe("x:a");
    expect(operationDraft("draft:a\nb")).toBe("a\nb");
    for (const other of [
      "queue",
      "capture",
      "page:3",
      "invalidate:c",
      "retry-state",
      "sizing",
      "drafts:a",
      "Draft:a",
      "xdraft:a",
      " draft:a",
      "draft:",
      "receipt:",
      "",
    ])
      expect(operationDraft(other), other).toBeNull();
  });

  test("a draft's two operations are exactly its own, and an id that ends the same way is another draft's", () => {
    expect(draftOperations("a")).toEqual(["draft:a", "receipt:a"]);
    const ours = new Set(draftOperations("a"));
    for (const other of ["draft:ba", "receipt:ba", "draft:x:a", "draft:aa"])
      expect(ours.has(other), other).toBe(false);
    // The identity is the parsed id, not the end of the string.
    for (const other of ["draft:ba", "receipt:ba", "draft:x:a"])
      expect(operationDraft(other) === "a", other).toBe(false);
  });
});

// ---- R46: the success of a write ends that write's failures ----------------------------------------------------------------------
type Fault = "below_bound" | "streak" | "marker" | "memory";
const FAULTS: Fault[] = ["below_bound", "streak", "marker", "memory"];

/** A world with an old draft where the method needs one, and the unrelated histories every case must leave as they were. */
async function arranged(method: Method): Promise<{
  w: OutboxWorld;
  target: string;
  unrelated: Record<string, number>;
  budgets: OutboxWorld["sync"] extends () => infer S
    ? S extends { read_retry_states: infer B }
      ? B
      : never
    : never;
}> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [cacheRow({ id: "r", version: 5 })]);
  // Histories that belong to other operations and callers: a success of ours must leave every one of them alone.
  const unrelated = {
    "draft:other": 2,
    "receipt:other": 1,
    "page:9": 1,
    capture: 1,
    "invalidate:c": 2,
  };
  w.setSync({
    local_write_streaks: { ...unrelated },
    read_retry_states: { sync: onReadFailure(initialReadRetry(), w.now()) },
  });
  if (method !== "enqueue")
    expect((await w.outbox.enqueue(edit("old"))).kind).toBe("queued");
  if (method === "supersede") {
    // The replacement of a conflicted draft, as a person resolves one.
    w.script.push(w.error(409, "operation_conflict"));
    w.online = true;
    w.start();
    await w.settle();
    expect(w.drafts()[0]?.status).toBe("operation_conflict");
    w.online = false;
    w.fire();
    await w.settle();
    w.dispatcher.stop();
  }
  const target = method === "enqueue" || method === "supersede" ? "new" : "old";
  return { w, target, unrelated, budgets: w.sync().read_retry_states };
}

const run = (w: OutboxWorld, method: Method) =>
  method === "enqueue"
    ? w.outbox.enqueue(edit("new"))
    : method === "editQueued"
      ? w.outbox.editQueued("old", edit("old"))
      : method === "supersede"
        ? w.outbox.supersede("old", edit("new"))
        : w.outbox.discard("old");

describe("R46: a successful retry ends its own failures, for every method, mechanism and reload", () => {
  for (const method of METHODS)
    for (const fault of FAULTS)
      for (const reload of [false, true]) {
        // A stop that only this tab's memory held is lost by a reload (the disclosed limitation): there is nothing to retire.
        if (fault === "memory" && reload) continue;
        test(`${method}, ${fault}${reload ? ", after a reload" : ""}: the record, the marker, the memory and the warning end with the success; nothing else does`, async () => {
          const { w, target, unrelated, budgets } = await arranged(method);
          const failures =
            fault === "below_bound" ? 2 : fault === "streak" ? 3 : 1;
          fail(w, PLAN[method], failures);
          if (fault === "marker" || fault === "memory") failCounter(w);
          if (fault === "memory") w.markerStorage.failWrites = true;
          for (let i = 0; i < failures; i += 1)
            expect(await run(w, method)).toEqual({
              kind: "refused",
              reason: "storage",
            });
          const own = `draft:${target}`;
          if (fault === "below_bound" || fault === "streak")
            expect(streaksOf(w)[own]).toBe(failures);
          if (fault === "marker") expect(markersOf(w)).toContain(own);
          if (fault === "memory") {
            expect(w.outbox.storageMemoryOnly.get()).toBe(true);
            w.markerStorage.failWrites = false;
          }
          expect(w.outbox.storageNotResponding.get()).toBe(
            fault !== "below_bound",
          );
          if (reload) {
            w.reload();
            await w.settle();
          }

          const done = await run(w, method);
          expect(done.kind).toBe(DONE[method]);

          // This operation's own state is gone, from every record...
          expect(streaksOf(w)[own]).toBeUndefined();
          expect(markersOf(w)).not.toContain(own);
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          expect(w.outbox.storageMemoryOnly.get()).toBe(false);
          // ...and nothing that is not its own: every other operation's history and the read budgets are as they were.
          expect(streaksOf(w)).toEqual(unrelated);
          expect(w.sync().read_retry_states).toEqual(budgets);

          // The saved work is sendable: nothing holds it back any more.
          w.online = true;
          w.start();
          w.goOnline();
          await w.settle();
          await w.advance(600_000);
          if (method !== "discard")
            expect(w.drafts().find((d) => d.local_id === target)?.status).toBe(
              "acknowledged",
            );
          else expect(w.drafts()).toEqual([]);
          expect(w.dispatcher.state.get().kind).toBe("idle");
          finish(w);
        });
      }
});

describe("R46: failures are CONSECUTIVE per operation (alternating failure and success)", () => {
  for (const method of METHODS)
    test(`${method}: two failures then a success, over and over, never reach the stop (the success may be a repeat of a save already made)`, async () => {
      const { w, target, unrelated } = await arranged(method);
      for (let round = 0; round < 4; round += 1) {
        fail(w, PLAN[method], 2);
        // Each round uses a draft of its own where the method consumes one, so every success is a real one.
        const id = method === "discard" ? `old${round}` : target;
        if (method === "discard")
          expect((await w.outbox.enqueue(edit(id))).kind).toBe("queued");
        const call = () =>
          method === "enqueue"
            ? w.outbox.enqueue(edit("new"))
            : method === "editQueued"
              ? w.outbox.editQueued("old", edit("old"))
              : method === "supersede"
                ? w.outbox.supersede("old", edit("new"))
                : w.outbox.discard(id);
        expect((await call()).kind).toBe("refused");
        expect(streaksOf(w)[`draft:${id}`]).toBe(1);
        expect((await call()).kind).toBe("refused");
        expect(streaksOf(w)[`draft:${id}`]).toBe(2);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        expect((await call()).kind).toBe(DONE[method]);
        expect(streaksOf(w)[`draft:${id}`]).toBeUndefined();
        expect(w.outbox.storageNotResponding.get()).toBe(false);
      }
      expect(streaksOf(w)).toEqual(unrelated);
      finish(w);
    });

  test("another operation's success does NOT end this operation's streak (the isolation the streak exists for)", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 2);
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("refused");
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("refused");
    expect((await w.outbox.enqueue(create("b"))).kind).toBe("queued");
    expect(streaksOf(w)["draft:a"]).toBe(2);
    fail(w, PLAN.enqueue, 1);
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("refused");
    expect(streaksOf(w)["draft:a"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });
});

describe("R46: a retirement that cannot be established keeps the stop, and its bookkeeping", () => {
  test("a success that does not land is a FAILURE, not a retirement: the streak goes on, and the save is not reported", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 4);
    for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(edit("new"));
    expect(streaksOf(w)["draft:new"]).toBe(3);
    // The next attempt would have succeeded; the transaction that carries both the save and the clearing aborts.
    expect(await w.outbox.enqueue(edit("new"))).toEqual({
      kind: "refused",
      reason: "storage",
    });
    expect(streaksOf(w)["draft:new"]).toBe(4);
    expect(w.drafts()).toEqual([]);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect((await w.outbox.enqueue(edit("new"))).kind).toBe("queued");
    expect(streaksOf(w)["draft:new"]).toBeUndefined();
    finish(w);
  });

  test("a marker that will not be removed is still a stop: the warning stays, and the next success removes it", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 1);
    failCounter(w);
    await w.outbox.enqueue(edit("new"));
    expect(markersOf(w)).toContain("draft:new");
    // `localStorage.removeItem` throws (blocked site data).
    (w.markerStorage as unknown as { removeItem: () => void }).removeItem =
      () => {
        throw new DOMException("blocked", "SecurityError");
      };
    expect((await w.outbox.enqueue(edit("new"))).kind).toBe("queued");
    // The save landed and its streak is gone, but the marker stands, so the stop does, and the warning says so.
    expect(markersOf(w)).toContain("draft:new");
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    Reflect.deleteProperty(w.markerStorage, "removeItem");
    // A repeat of the save (a duplicate, which writes nothing) is the next success of the same operation.
    expect((await w.outbox.enqueue(edit("new"))).kind).toBe("queued");
    expect(markersOf(w)).not.toContain("draft:new");
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a retry whose clearing cannot be written does not claim the recovery; the stop and the operation's place in the bookkeeping stay, and the next retry ends it", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 3);
    for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(edit("new"));
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    failCounter(w);
    w.outbox.retry("new");
    await w.settle();
    expect(streaksOf(w)["draft:new"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    w.outbox.retry("new");
    await w.settle();
    expect(streaksOf(w)["draft:new"]).toBeUndefined();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a retry whose clearing cannot be written keeps a failure BELOW the bound in the bookkeeping too: the next retry ends it", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 2);
    for (let i = 0; i < 2; i += 1) await w.outbox.enqueue(edit("new"));
    expect(streaksOf(w)["draft:new"]).toBe(2);
    failCounter(w);
    w.outbox.retry();
    await w.settle();
    expect(streaksOf(w)["draft:new"]).toBe(2);
    w.outbox.retry();
    await w.settle();
    expect(streaksOf(w)["draft:new"]).toBeUndefined();
    finish(w);
  });

  test("a save made right after a reload, which ends the very stop the page's first look found, leaves no stale warning behind", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 3);
    for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(edit("new"));
    expect(streaksOf(w)["draft:new"]).toBe(3);
    // The new page's first look at the record reads NOW (it sees the stop) and is told of it only after the save has landed.
    const held = delayResult(w.service.store, "data.readLocalWriteStops");
    w.reload();
    await w.settle();
    // The save is answered while that first look is still held (WEB-08d revision 17: a save that waits on the held look itself is an
    // assertion failure here, not a test that hangs until its timeout).
    let saved: { kind: string } | undefined;
    const save = w.outbox.enqueue(edit("new")).then((answer) => {
      saved = answer;
      return answer;
    });
    await w.settle();
    expect(saved?.kind).toBe("queued");
    await save;
    held.release();
    await w.settle();
    expect(streaksOf(w)).toEqual({
      "draft:other": 2,
      "receipt:other": 1,
      "page:9": 1,
      capture: 1,
      "invalidate:c": 2,
    });
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a stop recorded while the page's first look is still to be answered is not taken down by that older look", async () => {
    const { w } = await arranged("enqueue");
    // The look made when the new page started reads NOW (no stop yet) and is told of it later.
    const held = delayResult(w.service.store, "data.readLocalWriteStops");
    w.reload();
    await w.settle();
    fail(w, PLAN.enqueue, 3);
    for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(edit("new"));
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    held.release();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect(streaksOf(w)["draft:new"]).toBe(3);
    finish(w);
  });

  test("an abandoned draft's own markers end with it, whichever of its two operations they name", async () => {
    for (const method of ["discard", "supersede"] as const) {
      const { w } = await arranged(method);
      const mine = account(w);
      w.markers.set(scopeOf(mine), "draft:old");
      w.markers.set(scopeOf(mine), "receipt:old");
      w.markers.set(scopeOf(mine), "draft:older");
      w.reload();
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect((await run(w, method)).kind).toBe(DONE[method]);
      // Only the abandoned draft's: `older` is another draft.
      expect(markersOf(w)).toEqual(["draft:older"]);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      finish(w);
    }
  });

  test("when the record cannot be read the warning is not taken down on a guess", async () => {
    const { w } = await arranged("enqueue");
    fail(w, PLAN.enqueue, 3);
    for (let i = 0; i < 3; i += 1) await w.outbox.enqueue(edit("new"));
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    // A save of ANOTHER draft succeeds while the record cannot be read: the look at what stands finds nothing it can read.
    w.env.idb.inject({
      match: (tx) => tx.label === "data.readLocalWriteStops",
      mode: "error",
      times: 1,
    });
    expect((await w.outbox.enqueue(create("b"))).kind).toBe("queued");
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });
});

describe("R46: a replacement that takes a new place ends the failures in the transaction that writes its counter", () => {
  test("the counter, the replacement and the cleared streaks are one write", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: "r", version: 5 }),
      cacheRow({ id: "s", version: 5 }),
    ]);
    expect((await w.outbox.enqueue(edit("old", "r"))).kind).toBe("queued");
    w.script.push(w.error(409, "operation_conflict"));
    w.start();
    await w.settle();
    w.online = false;
    w.fire();
    await w.settle();
    expect((await w.outbox.enqueue(edit("later", "s"))).kind).toBe("queued");
    // The replacement uses the target of the later save, so it goes to the END of the queue and consumes a sequence number.
    fail(w, PLAN.supersede, 3);
    for (let i = 0; i < 3; i += 1)
      expect((await w.outbox.supersede("old", edit("new", "s"))).kind).toBe(
        "refused",
      );
    // The old draft carries a failure history of its own too: its abandonment ends it.
    w.setSync({
      local_write_streaks: {
        ...streaksOf(w),
        "draft:old": 2,
        "receipt:old": 2,
        "draft:later": 2,
      },
    });
    w.reload();
    await w.settle();
    const counter = w.sync().draft_seq;
    expect((await w.outbox.supersede("old", edit("new", "s"))).kind).toBe(
      "superseded",
    );
    expect(w.sync().draft_seq).toBe(counter + 1);
    expect(w.drafts().find((row) => row.local_id === "new")?.created_seq).toBe(
      counter + 1,
    );
    // The replacement's own, and the abandoned draft's two operations, are gone; the later save's is not.
    expect(streaksOf(w)).toEqual({ "draft:later": 2 });
    finish(w);
  });

  for (const method of ["discard", "supersede"] as const)
    test(`${method} abandons BOTH of the draft's operations in the record (and nothing of any other draft's)`, async () => {
      const { w, unrelated } = await arranged(method);
      w.setSync({
        local_write_streaks: {
          ...streaksOf(w),
          "draft:old": 2,
          "receipt:old": 2,
        },
      });
      w.reload();
      await w.settle();
      expect((await run(w, method)).kind).toBe(DONE[method]);
      expect(streaksOf(w)).toEqual(unrelated);
      finish(w);
    });

  test("a discard of a draft that is already gone (it was removed meanwhile) abandons its operations too; a refusal for any other reason abandons nothing", async () => {
    const { w } = await arranged("discard");
    fail(w, PLAN.discard, 3);
    for (let i = 0; i < 3; i += 1) await w.outbox.discard("old");
    expect(streaksOf(w)["draft:old"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    // The draft goes away without this page's discard (another tab's send was acknowledged and removed, say).
    w.env.idb.clearStore(NAME, "drafts");
    w.env.idb.clearStore(NAME, "draft_commands");
    expect(await w.outbox.discard("old")).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(streaksOf(w)["draft:old"]).toBeUndefined();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);

    // An acknowledged draft is refused, and that is not an abandonment: its history is as it was.
    const sent = await arranged("discard");
    sent.w.online = true;
    sent.w.start();
    await sent.w.settle();
    expect(sent.w.drafts()[0]?.status).toBe("acknowledged");
    sent.w.setSync({
      local_write_streaks: { ...streaksOf(sent.w), "draft:old": 2 },
    });
    expect(await sent.w.outbox.discard("old")).toEqual({
      kind: "refused",
      reason: "acknowledged",
    });
    expect(streaksOf(sent.w)["draft:old"]).toBe(2);
    finish(sent.w);
  });
});

// ---- R47: the warning is every stop that stands -----------------------------------------------------------------------------------
type Stop = "streak" | "marker" | "memory" | "receipt";
const STOPS: Stop[] = ["streak", "marker", "memory", "receipt"];

/** Stops draft `id` by the mechanism: three failed saves, a counter that could not be written, neither store, or three failed receipts. */
async function stopDraft(
  w: OutboxWorld,
  id: string,
  stop: Stop,
): Promise<void> {
  if (stop === "receipt") {
    // The dispatcher's own writes of an answer failed three times: `receipt:<id>` at the bound.
    w.setSync({
      local_write_streaks: { ...streaksOf(w), [`receipt:${id}`]: 3 },
    });
    return;
  }
  const times = stop === "streak" ? 3 : 1;
  fail(w, PLAN.enqueue, times);
  if (stop !== "streak") failCounter(w);
  if (stop === "memory") w.markerStorage.failWrites = true;
  for (let i = 0; i < times; i += 1)
    expect((await w.outbox.enqueue(create(id))).kind).toBe("refused");
  w.markerStorage.failWrites = false;
}
/**
 * Stops each draft by its mechanism. A receipt stop is the dispatcher's, written to the record directly, so the facade learns of it as
 * it does after a reload (its first look at the record): those go first, then the facade is rebuilt, and the stops this facade records
 * itself follow.
 */
async function stopBoth(
  w: OutboxWorld,
  stops: Array<[string, Stop]>,
): Promise<void> {
  const receipts = stops.filter(([, stop]) => stop === "receipt");
  for (const [id, stop] of receipts) await stopDraft(w, id, stop);
  if (receipts.length > 0) {
    w.reload();
    await w.settle();
  }
  for (const [id, stop] of stops)
    if (stop !== "receipt") await stopDraft(w, id, stop);
}
const stillStopped = (w: OutboxWorld, id: string, stop: Stop): boolean =>
  stop === "streak"
    ? streaksOf(w)[`draft:${id}`] === 3
    : stop === "receipt"
      ? streaksOf(w)[`receipt:${id}`] === 3
      : stop === "marker"
        ? markersOf(w).includes(`draft:${id}`)
        : w.outbox.storageMemoryOnly.get();

describe("R47: retrying one operation never hides another that is still stopped", () => {
  for (const a of STOPS)
    for (const b of STOPS)
      for (const reload of [false, true]) {
        // What only the memory of a tab holds is gone after a reload.
        if (reload && (a === "memory" || b === "memory")) continue;
        test(`A is stopped by ${a}, B by ${b}${reload ? ", after a reload" : ""}: A's retry keeps the warning and B's stop, B's retry then ends it`, async () => {
          const w = await outboxWorld();
          w.online = false;
          await stopBoth(w, [
            ["a", a],
            ["b", b],
          ]);
          expect(w.outbox.storageNotResponding.get()).toBe(true);
          if (reload) {
            w.reload();
            await w.settle();
            expect(w.outbox.storageNotResponding.get()).toBe(true);
          }

          w.outbox.retry("a");
          // B's stop is known to this page, so the warning is not taken down even for the instant before A's clearing is written.
          expect(w.outbox.storageNotResponding.get()).toBe(true);
          await w.settle();
          // A's stop is lifted, from the record it was in...
          expect(streaksOf(w)["draft:a"]).toBeUndefined();
          expect(streaksOf(w)["receipt:a"]).toBeUndefined();
          expect(markersOf(w)).not.toContain("draft:a");
          // ...and B's is untouched, and the shared warning stands.
          expect(stillStopped(w, "b", b)).toBe(true);
          expect(w.outbox.storageNotResponding.get()).toBe(true);
          expect(w.outbox.storageMemoryOnly.get()).toBe(b === "memory");

          w.outbox.retry("b");
          await w.settle();
          expect(streaksOf(w)).toEqual({});
          expect(markersOf(w)).toEqual([]);
          expect(w.outbox.storageNotResponding.get()).toBe(false);
          expect(w.outbox.storageMemoryOnly.get()).toBe(false);
          finish(w);
        });
      }

  test("the unscoped retry lifts every stop, of every mechanism, and then the warning ends", async () => {
    const w = await outboxWorld();
    w.online = false;
    await stopBoth(w, [
      ["a", "streak"],
      ["b", "marker"],
      ["c", "receipt"],
      ["d", "memory"],
    ]);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    w.outbox.retry();
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(markersOf(w)).toEqual([]);
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.outbox.storageMemoryOnly.get()).toBe(false);
    finish(w);
  });

  test("a retry for a draft that is not stopped changes nothing, and keeps the warning of the one that is", async () => {
    const w = await outboxWorld();
    w.online = false;
    await stopDraft(w, "a", "streak");
    w.outbox.retry("nobody");
    await w.settle();
    expect(streaksOf(w)["draft:a"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });

  test("the success of one draft's own save does not take another's warning down", async () => {
    const w = await outboxWorld();
    w.online = false;
    await stopDraft(w, "a", "streak");
    await stopDraft(w, "b", "marker");
    expect((await w.outbox.enqueue(create("a"))).kind).toBe("queued");
    expect(streaksOf(w)["draft:a"]).toBeUndefined();
    expect(markersOf(w)).toEqual(["draft:b"]);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect((await w.outbox.enqueue(create("b"))).kind).toBe("queued");
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("the success of a save made right after a reload does not hide a stop the page has not yet been told of", async () => {
    const w = await outboxWorld();
    w.online = false;
    await stopDraft(w, "a", "streak");
    await stopDraft(w, "b", "streak");
    w.reload();
    // No settle: the new facade's first look at the record may not have finished.
    expect((await w.outbox.enqueue(create("a"))).kind).toBe("queued");
    await w.settle();
    expect(streaksOf(w)["draft:b"]).toBe(3);
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    finish(w);
  });
});

describe("R47: ids that end the same way are different drafts (the public boundary accepts any string)", () => {
  const PAIRS: Array<[string, string]> = [
    ["a", "ba"],
    ["b", "ab"],
    ["x:a", "a"],
    ["a", "draft:a"],
  ];
  for (const [mine, other] of PAIRS)
    for (const stop of ["streak", "marker"] as const)
      test(`retry(${JSON.stringify(mine)}) leaves ${JSON.stringify(other)}'s ${stop} alone`, async () => {
        const w = await outboxWorld();
        w.online = false;
        await stopBoth(w, [
          [mine, stop],
          [other, stop],
        ]);
        w.outbox.retry(mine);
        await w.settle();
        expect(stillStopped(w, other, stop)).toBe(true);
        expect(stillStopped(w, mine, stop)).toBe(false);
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        w.outbox.retry(other);
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        finish(w);
      });
});

// ---- the dispatcher ----------------------------------------------------------------------------------------------------------------
describe("R46: the dispatcher's own successes end its failures", () => {
  const drive = async (w: OutboxWorld) => {
    w.start();
    await w.settle();
  };

  test("three isolated aborts of the queue read, with successful reads between them, are not three in a row", async () => {
    const w = await outboxWorld();
    for (let round = 0; round < 3; round += 1) {
      fail(w, "data.readDispatchWindow", 1);
      if (round === 0) w.start();
      else w.fire();
      await w.settle();
      expect(streaksOf(w).queue).toBe(1);
      await w.advance(250);
      // The read that follows succeeded: its failures end.
      expect(streaksOf(w).queue).toBeUndefined();
    }
    expect(w.dispatcher.state.get().kind).toBe("idle");
    finish(w);
  });

  test("three failures IN A ROW still stop it, and the stop is lifted by the next read that lands", async () => {
    const w = await outboxWorld();
    fail(w, "data.readDispatchWindow", 3);
    w.start();
    await w.settle();
    await w.advance(5_000);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    expect(streaksOf(w).queue).toBe(3);
    w.fire();
    await w.settle();
    expect(streaksOf(w).queue).toBeUndefined();
    expect(w.dispatcher.state.get().kind).toBe("idle");
    finish(w);
  });

  test("a count left by an earlier page is ended by the first read that lands after a reload", async () => {
    const w = await outboxWorld();
    w.setSync({ local_write_streaks: { queue: 2, "draft:other": 2 } });
    w.reload();
    await drive(w);
    expect(streaksOf(w)).toEqual({ "draft:other": 2 });
    finish(w);
  });

  test("a queue stop that only a marker or the memory holds ends with the read that lands", async () => {
    const w = await outboxWorld();
    fail(w, "data.readDispatchWindow", 1);
    failCounter(w);
    w.start();
    await w.settle();
    expect(markersOf(w)).toEqual(["queue"]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    w.fire();
    await w.settle();
    expect(markersOf(w)).toEqual([]);
    expect(w.dispatcher.state.get().kind).toBe("idle");
    finish(w);
  });

  test("a clearing of the queue count that cannot be written is tried again by the next read", async () => {
    const w = await outboxWorld();
    w.setSync({ local_write_streaks: { queue: 2 } });
    failCounter(w, 1);
    w.start();
    await w.settle();
    expect(streaksOf(w).queue).toBe(2);
    w.fire();
    await w.settle();
    expect(streaksOf(w).queue).toBeUndefined();
    finish(w);
  });

  test("a request that got no answer, recorded successfully after a local abort, ends the receipt count; the network budget is the draft's own and is counted as it always was", async () => {
    for (const fault of [false, true]) {
      const w = await outboxWorld();
      w.put("cache", [cacheRow({ id: "r", version: 5 })]);
      w.online = false;
      expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
      w.script.push(
        ...Array.from({ length: 20 }, () => new Error("offline request")),
      );
      if (fault) fail(w, "data.recordFailureOfSend", 1);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(250);
      expect(streaksOf(w)["receipt:a"]).toBeUndefined();
      // The draft's own network budget is its own: one request that got no answer was counted, whatever the local write did.
      expect(w.drafts()[0]?.attempts).toBe(1);
      expect(w.drafts()[0]?.retry_state).not.toBeNull();
      finish(w);
    }
  });

  test("a claim that lands ends the failures of the claim, whoever saw them; a stalled draft is not claimed", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    w.online = false;
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
    expect((await w.outbox.enqueue(create("b"))).kind).toBe("queued");
    w.setSync({
      local_write_streaks: { "draft:a": 2, "draft:b": 3, "receipt:a": 1 },
    });
    w.reload();
    w.online = true;
    await drive(w);
    await w.advance(5_000);
    // `a` was sent (its claim landed): the claim's count is gone, the receipt's too (its own success), and nothing of b's.
    expect(streaksOf(w)).toEqual({ "draft:b": 3 });
    expect(w.sent.map((r) => r.key)).toEqual(["a"]);
    finish(w);
  });

  test("a stop that ended in the record is released by the dispatcher without a restart or a retry (the draft's own edit)", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    w.online = false;
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
    w.setSync({ local_write_streaks: { "draft:a": 3 } });
    w.reload();
    w.online = true;
    await drive(w);
    expect(w.sent).toEqual([]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    expect((await w.outbox.editQueued("a", edit("a"))).kind).toBe("edited");
    await w.settle();
    await w.advance(5_000);
    expect(w.drafts()[0]?.status).toBe("acknowledged");
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a draft the dispatcher itself stalled (its claim failed three times) is released when its own edit ends the stop", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    w.online = false;
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
    fail(w, "data.markInFlight", 3);
    w.online = true;
    w.start();
    await w.settle();
    await w.advance(5_000);
    expect(streaksOf(w)["draft:a"]).toBe(3);
    expect(w.sent).toEqual([]);
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    expect((await w.outbox.editQueued("a", edit("a"))).kind).toBe("edited");
    await w.settle();
    await w.advance(5_000);
    expect(w.drafts()[0]?.status).toBe("acknowledged");
    expect(streaksOf(w)).toEqual({});
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    finish(w);
  });

  test("discarding a stopped draft ends the dispatcher's stop as well as the warning", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    w.online = false;
    expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
    w.setSync({ local_write_streaks: { "receipt:a": 3 } });
    w.reload();
    w.online = true;
    await drive(w);
    expect(w.dispatcher.state.get().kind).toBe("stopped");
    expect(w.outbox.storageNotResponding.get()).toBe(true);
    expect((await w.outbox.discard("a")).kind).toBe("discarded");
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    expect(w.dispatcher.state.get()).toEqual({ kind: "idle" });
    finish(w);
  });

  for (const kind of ["a receipt", "a rejection", "no answer"] as const)
    test(`a marker that appeared for the draft while its request was in flight (${kind}) ends with the answer's own success`, async () => {
      const w = await outboxWorld();
      w.put("cache", [cacheRow({ id: "r", version: 5 })]);
      let answer: (response: Response) => void = () => undefined;
      let lose: (error: unknown) => void = () => undefined;
      w.script.push(
        () =>
          new Promise<Response>((resolve, reject) => {
            answer = resolve;
            lose = reject;
          }),
      );
      w.start();
      await w.settle();
      expect((await w.outbox.enqueue(edit("a"))).kind).toBe("queued");
      await w.settle();
      expect(w.sent).toHaveLength(1);
      // Another tab's stop for this draft's receipts is recorded while the answer is outstanding.
      w.markers.set(scopeOf(account(w)), "receipt:a");
      if (kind === "a receipt") answer(w.receipt());
      else if (kind === "a rejection") answer(w.error(404, "not_found"));
      else lose(new TypeError("network"));
      await w.settle();
      expect(w.drafts()[0]?.status).toBe(
        kind === "a receipt"
          ? "acknowledged"
          : kind === "a rejection"
            ? "rejected"
            : "in_flight",
      );
      expect(markersOf(w)).toEqual([]);
      finish(w);
    });

  test("the dispatcher's own queue stop is not the outbox's storage warning, before or after a reload", async () => {
    const w = await outboxWorld();
    fail(w, "data.readDispatchWindow", 1);
    failCounter(w);
    w.start();
    await w.settle();
    expect(markersOf(w)).toEqual(["queue"]);
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    w.reload();
    await w.settle();
    expect(w.outbox.storageNotResponding.get()).toBe(false);
    finish(w);
  });

  test("a clearing that cannot be written keeps the operation in the dispatcher's bookkeeping: the next retry ends the count", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    fail(w, "data.admitReceipt", 1);
    w.start();
    await w.settle();
    expect((await w.outbox.enqueue(create("a"))).kind).toBe("queued");
    await w.settle();
    // The receipt's write failed once; the page goes offline before anything else is attempted, so nothing succeeds and nothing ends it.
    w.online = false;
    w.fire();
    await w.settle();
    expect(streaksOf(w)).toEqual({ "receipt:a": 1 });
    failCounter(w);
    w.dispatcher.retry();
    await w.settle();
    expect(streaksOf(w)).toEqual({ "receipt:a": 1 });
    w.dispatcher.retry();
    await w.settle();
    expect(streaksOf(w)).toEqual({});
    finish(w);
  });

  test("the dispatcher's retry for one draft is matched by the exact id: `a` does not release `ba`", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    // Each draft's receipt fails three times: both stop (the dispatcher's own failures, so its memory knows them).
    fail(w, "data.admitReceipt", 6);
    w.start();
    await w.settle();
    expect((await w.outbox.enqueue(create("a"))).kind).toBe("queued");
    expect((await w.outbox.enqueue(create("ba"))).kind).toBe("queued");
    await w.settle();
    await w.advance(10_000);
    expect(streaksOf(w)).toEqual({ "receipt:a": 3, "receipt:ba": 3 });
    const sent = w.sent.length;
    w.dispatcher.retry("a");
    await w.settle();
    expect(w.sent.length).toBe(sent + 1);
    expect(w.sent.at(-1)?.key).toBe("a");
    expect(streaksOf(w)).toEqual({ "receipt:ba": 3 });
    expect(w.dispatcher.state.get()).toEqual({
      kind: "stopped",
      cause: "local_storage",
    });
    finish(w);
  });
});

// ---- the public notice path --------------------------------------------------------------------------------------------------------
describe("R47: the notice a person reads follows every stop (the controller's own facade, markers and record)", () => {
  async function envOver(w: OutboxWorld) {
    const runtime = new w.env.modules.accountService.DataRuntime({
      identity: w.identity,
      persistence: unorderedPersistence,
      registry: w.page.registry,
      open: (account, options) => w.page.open(account, options),
    });
    const listeners = new Set<() => void>();
    const env = createDataEnv({
      identity: w.identity,
      loadRuntime: async () => runtime,
      online: {
        get: () => w.online,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      quota: w.quota,
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      readMe: async () => ({ kind: "closed" }),
      currentDeviceId: async () => ({ kind: "closed" }),
      onOnline: () => () => undefined,
      markers: pageMarkers(w.markerStorage, { events: false }),
    });
    await w.settle();
    return env;
  }
  const notices = (env: Awaited<ReturnType<typeof envOver>>) =>
    deriveNotices(env.inputs.get()).filter(
      (notice) => notice.kind === "storage_not_responding",
    );

  for (const stop of ["streak", "marker"] as const)
    test(`two drafts stopped by ${stop} on a page that reloaded: "Try again" for one keeps the notice, for the other ends it`, async () => {
      const w = await outboxWorld();
      w.online = false;
      await stopBoth(w, [
        ["a", stop],
        ["b", stop],
      ]);
      const env = await envOver(w);
      await w.settle();
      expect(env.inputs.get().storageNotResponding).toBe(true);
      expect(notices(env)).toHaveLength(1);

      env.actions.retryChanges("a");
      await w.settle();
      expect(env.inputs.get().storageNotResponding).toBe(true);
      expect(notices(env)).toHaveLength(1);
      expect(stillStopped(w, "b", stop)).toBe(true);

      env.actions.retryChanges("b");
      await w.settle();
      expect(env.inputs.get().storageNotResponding).toBe(false);
      expect(notices(env)).toHaveLength(0);
      expect(streaksOf(w)).toEqual({});
      expect(markersOf(w)).toEqual([]);
      env.dispose();
      finish(w);
    });

  test("the controller's save that succeeds ends its own stop and the notice with it", async () => {
    const w = await outboxWorld();
    w.online = false;
    await stopDraft(w, "a", "streak");
    const env = await envOver(w);
    await w.settle();
    expect(notices(env)).toHaveLength(1);
    const facade = env.outbox();
    if (facade === null) throw new Error("setup: the controller has no outbox");
    expect((await facade.enqueue(create("a"))).kind).toBe("queued");
    await w.settle();
    expect(notices(env)).toHaveLength(0);
    expect(streaksOf(w)).toEqual({});
    env.dispose();
    finish(w);
  });
});

// ---- a seeded random program against an independent model of every operation's failure state --------------------------------------
describe("R46 and R47: a seeded random program agrees with an independent model of every record of a stop", () => {
  /** A small deterministic generator (mulberry32). */
  const generator = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  interface Model {
    count: number;
    marker: boolean;
    memory: boolean;
    /** This page has seen a failure of the draft's saves since it started (a retry reaches such a count below the bound). */
    known: boolean;
  }
  // `ba` ends the way `a` does, and `x:a` holds a colon: the ids the identity must tell apart.
  const IDS = ["a", "ba", "b", "x:a"];
  const SEEDS = 40;
  const STEPS = 28;

  test(`${SEEDS} programs of ${STEPS} steps (failed saves of every mechanism, successes, successes whose result is delivered late, retries for one draft and for all, reloads): the record, the markers, the memory and the warning match the model after every step`, async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = generator(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(next() * items.length)] as T;
      const w = await outboxWorld();
      w.online = false;
      const model = new Map<string, Model>(
        IDS.map((id) => [
          id,
          { count: 0, marker: false, memory: false, known: false },
        ]),
      );
      const trail: string[] = [];
      /**
       * A success whose transaction has COMMITTED and whose result is delivered later (R50, revision 31). The durable count went with the
       * transaction; the page's memory of the stop and the marker end at delivery, and only the instances that stood when it was issued:
       * a marker or a hold recorded since (a newer failure of the same operation) is not the instance it saw.
       */
      let pending: {
        id: string;
        release(): void;
        done: Promise<unknown>;
        olderMarker: boolean;
        olderMemory: boolean;
        failedSince: boolean;
      } | null = null;
      const deliver = async () => {
        if (pending === null) return;
        const late = pending;
        pending = null;
        late.release();
        expect(((await late.done) as { kind: string }).kind).toBe("queued");
        const state = model.get(late.id) as Model;
        if (state.marker && late.olderMarker) state.marker = false;
        if (state.memory && late.olderMemory) state.memory = false;
        // What the facade noted of its own failures ends with the success, unless it failed again after the write was issued.
        if (!late.failedSince) state.known = false;
        trail.push(`deliver(${late.id})`);
        await w.settle();
      };
      const check = () => {
        const where = `seed ${seed}, after ${trail.join(" ; ")}`;
        const streaks = streaksOf(w);
        const markers = markersOf(w);
        let stopped = false;
        let memory = false;
        for (const [id, state] of model) {
          expect(streaks[`draft:${id}`] ?? 0, `${where}: count of ${id}`).toBe(
            state.count,
          );
          expect(
            markers.includes(`draft:${id}`),
            `${where}: marker of ${id}`,
          ).toBe(state.marker);
          if (state.count >= 3 || state.marker || state.memory) stopped = true;
          if (state.memory) memory = true;
        }
        expect(w.outbox.storageNotResponding.get(), `${where}: warning`).toBe(
          stopped,
        );
        expect(w.outbox.storageMemoryOnly.get(), `${where}: memory-only`).toBe(
          memory,
        );
      };
      for (let step = 0; step < STEPS; step += 1) {
        const id = pick(IDS);
        const state = model.get(id) as Model;
        const action = pick([
          "fail",
          "fail",
          "fail",
          "succeed",
          "succeed",
          "late-succeed",
          "deliver",
          "retry-one",
          "retry-all",
          "reload",
        ] as const);
        if (action === "late-succeed") {
          // One late result at a time: a second asks for the first to be delivered.
          if (pending !== null) await deliver();
          else {
            const held = delayResult(w.service.store, PLAN.enqueue);
            const done = w.outbox.enqueue(create(id));
            await w.settle();
            // The transaction committed at once (its durable count went with it); the answer is held.
            state.count = 0;
            pending = {
              id,
              release: held.release,
              done,
              olderMarker: state.marker,
              olderMemory: state.memory,
              failedSince: false,
            };
            trail.push(`late-succeed(${id})`);
          }
        } else if (action === "deliver") await deliver();
        else if (action === "fail") {
          const mechanism = pick([
            "counter",
            "counter",
            "marker",
            "memory",
          ] as const);
          fail(w, PLAN.enqueue, 1);
          if (mechanism !== "counter") failCounter(w);
          if (mechanism === "memory") w.markerStorage.failWrites = true;
          expect(await w.outbox.enqueue(create(id))).toEqual({
            kind: "refused",
            reason: "storage",
          });
          w.markerStorage.failWrites = false;
          state.known = true;
          if (mechanism === "counter") state.count += 1;
          else if (mechanism === "marker") state.marker = true;
          else state.memory = true;
          // A failure after a late success was issued is a NEWER instance than the one that success saw.
          if (pending !== null && pending.id === id) {
            pending.failedSince = true;
            if (mechanism === "marker") pending.olderMarker = false;
            if (mechanism === "memory") pending.olderMemory = false;
          }
          trail.push(`fail(${id}, ${mechanism})`);
        } else if (action === "succeed") {
          expect((await w.outbox.enqueue(create(id))).kind).toBe("queued");
          Object.assign(state, {
            count: 0,
            marker: false,
            memory: false,
            known: false,
          });
          trail.push(`succeed(${id})`);
        } else if (action === "retry-one" || action === "retry-all") {
          if (action === "retry-one") w.outbox.retry(id);
          else w.outbox.retry();
          await w.settle();
          for (const [other, o] of model)
            if (action === "retry-all" || other === id) {
              // A count below the bound is reached only when this page saw it fail; a stop, a marker and a memory stop always.
              if (o.count >= 3 || o.known || o.marker || o.memory)
                Object.assign(o, { count: 0, marker: false, memory: false });
              o.known = false;
            }
          trail.push(action === "retry-one" ? `retry(${id})` : "retry()");
        } else {
          // A page that reloads has no late result to deliver: it is delivered first.
          await deliver();
          w.reload();
          await w.settle();
          for (const o of model.values()) {
            o.memory = false;
            o.known = false;
          }
          trail.push("reload");
        }
        await w.settle();
        check();
      }
      await deliver();
      check();
      finish(w);
    }
  }, 120_000);
});

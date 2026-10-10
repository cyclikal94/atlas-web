// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DIRECTORY_PREFIX,
  MARKER_PREFIX,
  SLOT_COUNT,
} from "../../src/data/engine/write-failure-marker";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import {
  markerKeys,
  markerStands,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R47 (revision 28): an unreadable marker store is UNKNOWN, not empty, in every consumer of the markers the outbox has.
 *
 * Revision 27 made an unreadable DATABASE record unknown, but the module of the fallback markers still answered a failed enumeration with
 * an empty list and a failed read with `false`, and the facade marked its look `known` whenever the DATABASE read landed. So a stop that
 * only a marker recorded (the counter write had failed too) was hidden by the next unrelated save: the warning went down, and an ordinary
 * wake of the dispatcher sent the stopped draft although nothing had retried, edited or abandoned it. The markers now keep what this page
 * has established and report whether a read was complete (`marker-unknown.test.ts`); the facade's look is `known` only when EVERY record
 * it consults could be read, and the dispatcher reads the page's established markers at its window, at the claim and at the step that
 * issues the request.
 *
 * Every schedule is run for each way a store can be unreadable (the enumeration, the individual read, both) because a page can lose one
 * and keep the other. FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage`
 * (whose reads throw a `SecurityError`); native Dexie/IndexedDB and the page's real `localStorage` are E-O10.
 */
const request = (
  localId: string,
  label: string = localId,
  target = `r-${localId}`,
): EnqueueRequest => ({
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
      label,
      expected_version: bases[target] as number,
    },
  }),
});

type Mechanism = "streak" | "marker" | "memory";
const MECHANISMS: Mechanism[] = ["streak", "marker", "memory"];
/**
 * ADAPTED, revision 33 (R55): a marker is found by reading the directories' fixed addresses and the key of each failure they list, and
 * the origin's keys are never listed. A read can fail for the directories (`directory`), for the listed failure's own key (`marker`:
 * that operation, and no other, is then unknown) or for every key (`getItem`).
 */
type Unreadable = "directory" | "marker" | "getItem";
const KINDS: Unreadable[] = ["directory", "marker", "getItem"];

const unreadable = (w: OutboxWorld, kind: Unreadable): void => {
  w.markerStorage.failGets = kind === "getItem";
  w.markerStorage.failGetsFor =
    kind === "directory"
      ? (key) => key.startsWith(DIRECTORY_PREFIX)
      : kind === "marker"
        ? (key) => key.startsWith(MARKER_PREFIX)
        : null;
};
const readable = (w: OutboxWorld): void => {
  w.markerStorage.failEnumeration = false;
  w.markerStorage.failGets = false;
  w.markerStorage.failGetsFor = null;
};

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const account = (w: OutboxWorld): string => w.service.account;
/**
 * ADAPTED, revision 32 (R52): a marker is a key of its own (`<operation>#<page>.<count>`), written once and removed by that exact key,
 * and it is READ by listing the account's keys: `unreadable("getItem")` no longer makes one unreadable (no value is read), and the cases
 * that varied which way the store could not be read keep their names and say what is now so. A retry or a success that must name a
 * marker nothing could be listed for names nothing and removes nothing.
 */
const where = (w: OutboxWorld, operation: string) => ({
  streak: w.sync().local_write_streaks[operation] ?? 0,
  marker: markerStands(w.markerStorage, account(w), operation),
  memory: w.markers.stops.operations(w.service).includes(operation),
});
const STANDING = (mechanism: Mechanism) => ({
  streak: mechanism === "streak" ? 3 : 0,
  marker: mechanism === "marker",
  memory: mechanism === "memory",
});
const NOTHING = { streak: 0, marker: false, memory: false };
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });

async function world(): Promise<OutboxWorld> {
  const w = await outboxWorld();
  w.online = false;
  w.put("cache", [
    cacheRow({ id: "r-a", version: 5 }),
    cacheRow({ id: "r-b", version: 5 }),
    cacheRow({ id: "r-c", version: 5 }),
  ]);
  return w;
}

async function facadeStop(
  w: OutboxWorld,
  mechanism: Mechanism,
  id = "a",
): Promise<void> {
  const times = mechanism === "streak" ? 3 : 1;
  fail(w, "data.editQueuedDraft", times);
  if (mechanism !== "streak") fail(w, "data.recordLocalWriteOutcome", 1);
  w.markerStorage.failWrites = mechanism === "memory";
  for (let i = 0; i < times; i += 1)
    expect((await w.outbox.editQueued(id, request(id, "unsaved"))).kind).toBe(
      "refused",
    );
  w.markerStorage.failWrites = false;
  expect(w.outbox.storageNotResponding.get()).toBe(true);
  expect(where(w, `draft:${id}`)).toEqual(STANDING(mechanism));
}

async function queued(
  w: OutboxWorld,
  ids: readonly string[] = ["a"],
): Promise<void> {
  for (const id of ids)
    expect((await w.outbox.enqueue(request(id, "original"))).kind).toBe(
      "queued",
    );
  await w.settle();
}

const hint = (w: OutboxWorld): void =>
  w.deliver({
    type: "data_changed",
    account: account(w),
    stores: ["drafts"],
  });

// ---- the warning, and what an ordinary wake sends -----------------------------------------------------------------------------------
describe("R47: a stop that only a marker (or the page's memory) holds is not hidden by anything unrelated while the markers cannot be read", () => {
  const unrelated: Array<{
    name: string;
    run(w: OutboxWorld): Promise<void> | void;
  }> = [
    {
      name: "a save of a draft for an independent resource",
      run: async (w) => {
        expect((await w.outbox.enqueue(request("b"))).kind).toBe("queued");
      },
    },
    {
      name: "a save of another draft for the SAME resource",
      run: async (w) => {
        expect((await w.outbox.enqueue(request("b", "b", "r-a"))).kind).toBe(
          "queued",
        );
      },
    },
    {
      name: "the edit of another draft",
      run: async (w) => {
        expect((await w.outbox.enqueue(request("b"))).kind).toBe("queued");
        expect(
          (await w.outbox.editQueued("b", request("b", "again"))).kind,
        ).toBe("edited");
      },
    },
    {
      name: "the discard of another draft",
      run: async (w) => {
        expect((await w.outbox.enqueue(request("b"))).kind).toBe("queued");
        expect((await w.outbox.discard("b")).kind).toBe("discarded");
      },
    },
    {
      name: '"Try again" for another draft',
      run: (w) => {
        w.outbox.retry("b");
        w.dispatcher.retry("b");
      },
    },
    {
      name: "a hint that another tab changed the database",
      run: (w) => hint(w),
    },
    {
      name: "losing connectivity and regaining it",
      run: (w) => {
        w.online = false;
        w.fire();
        w.goOnline();
      },
    },
  ];

  for (const kind of KINDS)
    for (const mechanism of MECHANISMS)
      for (const action of unrelated)
        test(`${mechanism}, ${kind} unreadable: after ${action.name} the warning stands and the draft is not sent`, async () => {
          const w = await world();
          try {
            await queued(w);
            await facadeStop(w, mechanism);
            unreadable(w, kind);
            await action.run(w);
            await w.settle();
            expect(w.outbox.storageNotResponding.get()).toBe(true);
            expect(w.outbox.storageMemoryOnly.get()).toBe(
              mechanism === "memory",
            );
            w.online = true;
            w.start();
            await w.settle();
            await w.advance(10_000);
            expect(w.sent.filter((s) => s.key === "a")).toHaveLength(0);
            expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
            expect(w.outbox.storageNotResponding.get()).toBe(true);
          } finally {
            finish(w);
          }
        });

  for (const kind of KINDS)
    test(`${kind} unreadable: the draft that was not stopped is sent while the stopped one is held, unless NO way of reading its marker lands (adapted, revision 29)`, async () => {
      const w = await world();
      try {
        await queued(w, ["a", "b"]);
        await facadeStop(w, "marker", "a");
        unreadable(w, kind);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        // ADAPTED, revision 33: when only the stopped draft's own marker key cannot be read, that operation is unknown and `b` (whose
        // operations list nothing) is sent; when the directories or every key cannot be read, nothing can be said of `b`, which is held
        // with `a` until a read lands.
        expect(w.sent.map((s) => s.key)).toEqual(
          kind === "marker" ? ["b"] : [],
        );
        expect(where(w, "draft:a")).toEqual(STANDING("marker"));
      } finally {
        finish(w);
      }
    });
});

// ---- recovery is only ever established ----------------------------------------------------------------------------------------------
describe("R47: what ends the stop is established, never presumed from a read that failed", () => {
  for (const kind of KINDS)
    test(`${kind} unreadable then readable again: the marker is still there, so the stop and the warning are, until the explicit retry`, async () => {
      const w = await world();
      try {
        await queued(w);
        await facadeStop(w, "marker");
        unreadable(w, kind);
        expect((await w.outbox.enqueue(request("b"))).kind).toBe("queued");
        await w.settle();
        readable(w);
        hint(w);
        await w.settle();
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        expect(w.sent.map((s) => s.key)).toEqual(["b"]);
        w.outbox.retry("a");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key).sort()).toEqual(["a", "b"]);
        expect(where(w, "draft:a")).toEqual(NOTHING);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
      } finally {
        finish(w);
      }
    });

  for (const kind of KINDS)
    test(`${kind} unreadable: a marker that ANOTHER tab removed is gone only when a read that lands says so, and then the warning goes and the draft is sent`, async () => {
      const w = await world();
      try {
        await queued(w);
        await facadeStop(w, "marker");
        w.online = true;
        w.start();
        await w.settle();
        unreadable(w, kind);
        // Another tab recorded the operation's success and removed the marker.
        for (const key of markerKeys(w.markerStorage, account(w), "draft:a"))
          w.markerStorage.page("another-tab").storage.removeItem(key);
        hint(w);
        await w.settle();
        // ADAPTED, revision 33: whichever read cannot be made, the removal is not known to have landed until one does.
        expect(w.outbox.storageNotResponding.get()).toBe(true);
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        readable(w);
        hint(w);
        await w.settle();
        expect(w.outbox.storageNotResponding.get()).toBe(false);
        readable(w);
        w.dispatcher.wake();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(w.outbox.storageNotResponding.get()).toBe(false);
      } finally {
        finish(w);
      }
    });

  // ADAPTED, revision 30 (separately labelled, for the reviewer to accept or reject). Revision 28 sent the draft here, on the strength of
  // the edit's own success, and revision 29 kept it by treating the removal that returned as evidence that the key was gone. The review
  // of revision 29 showed that this lets an OLDER recovery override a NEWER stop that another page recorded since (see
  // `outbox-cold-markers.test.ts`, "an older recovery, then another page's NEW stop"). The intent is kept: the edit's success ends exactly
  // its own operation (the marker is removed, the warning waits for a read), and the draft goes out once, edited, as soon as a read
  // LANDS and finds nothing; what is no longer so is that it goes out while nothing can be read.
  test("(adapted) the draft's OWN successful edit ends the marker even while the markers cannot be read; the draft is sent once a read lands, and the warning says recovered then", async () => {
    const w = await world();
    try {
      await queued(w);
      await facadeStop(w, "marker");
      w.online = true;
      w.start();
      await w.settle();
      unreadable(w, "getItem");
      expect(
        (await w.outbox.editQueued("a", request("a", "edited"))).kind,
      ).toBe("edited");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      // ADAPTED, revision 32 (R52): the page named the instance (its facade listed it when it was written), and the removal of a key that
      // names its failure needs no read, so the edit's success ends it at once. Revision 31 owed the removal to the first read that
      // landed, because it had to compare a shared value before removing it.
      expect(where(w, "draft:a")).toEqual(NOTHING);
      // A read that could not be made does not say "recovered": the warning follows the first read that lands.
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      readable(w);
      hint(w);
      await w.settle();
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.sent[0]?.body).toContain("edited");
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      expect(where(w, "draft:a")).toEqual(NOTHING);
    } finally {
      finish(w);
    }
  });

  // ADAPTED, revision 31 (separately labelled, for the reviewer to accept or reject). A page that never read the marker (a reload with the
  // store unreadable from its first read) cannot name the instance that stands, so the draft's own successful edit cannot show that the
  // marker it finds later predates the write: another page may have recorded a NEWER stop meanwhile (R50). Revisions 28 to 30 removed
  // the record blind; now only the person's "Try again" ends a stop nothing here could name, and the draft goes then, edited.
  test("(adapted, revision 31) a page that never read the marker (a reload), unreadable from its first read: the draft's own successful edit cannot end it; the person's retry does, and the draft is sent", async () => {
    const w = await world();
    try {
      await queued(w);
      await facadeStop(w, "marker");
      w.dispatcher.stop();
      unreadable(w, "getItem");
      w.reload();
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      expect(
        (await w.outbox.editQueued("a", request("a", "edited"))).kind,
      ).toBe("edited");
      await w.settle();
      expect(where(w, "draft:a")).toEqual({ ...NOTHING, marker: true });
      readable(w);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      // The record is read now: a stop that the edit did not end.
      expect(w.sent).toHaveLength(0);
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(where(w, "draft:a")).toEqual(NOTHING);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(w.sent[0]?.body).toContain("edited");
    } finally {
      finish(w);
    }
  });

  test("(adapted, revision 30) a marker that cannot be REMOVED while the store is unreadable is still a stop: the next retry removes it, and the draft is sent once a read lands", async () => {
    const w = await world();
    try {
      await queued(w);
      await facadeStop(w, "marker");
      unreadable(w, "getItem");
      const removeItem = w.markerStorage.removeItem.bind(w.markerStorage);
      w.markerStorage.removeItem = () => {
        throw new DOMException("refused", "SecurityError");
      };
      expect(
        (await w.outbox.editQueued("a", request("a", "edited"))).kind,
      ).toBe("edited");
      await w.settle();
      expect(where(w, "draft:a").marker).toBe(true);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      w.markerStorage.removeItem = removeItem;
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      // ADAPTED, revision 32 (R52): the instance the edit ended is OWED its removal (the same exact key), and the page no longer takes it
      // as a stop it knows of, so a retry made now (nothing can be listed) names nothing. The first listing that lands makes the
      // removal; a removal is still not proof of absence (R47, revision 30), so the draft goes once that same listing finds nothing.
      expect(where(w, "draft:a").marker).toBe(true);
      expect(w.sent).toHaveLength(0);
      readable(w);
      await w.advance(70_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(where(w, "draft:a")).toEqual(NOTHING);
    } finally {
      finish(w);
    }
  });
});

// ---- the dispatcher's own reads of the markers --------------------------------------------------------------------------------------
describe("R47: the dispatcher honours a marker this page established at its window, at the claim and at the step that issues the request", () => {
  for (const kind of KINDS)
    test(`${kind} unreadable: a marker established while the queue read was held is honoured by the claim`, async () => {
      const w = await world();
      try {
        await queued(w);
        const real = w.service.store.run.bind(w.service.store) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        let release: () => void = () => undefined;
        let armed = true;
        (w.service.store as { run: unknown }).run = (
          plan: { name: string },
          input: unknown,
          options: unknown,
        ) => {
          const answer = real(plan, input, options);
          if (!armed || plan.name !== "data.readDispatchWindow") return answer;
          armed = false;
          return new Promise<unknown>((resolve, reject) => {
            release = () => {
              void answer.then(resolve, reject);
            };
          });
        };
        w.online = true;
        w.start();
        await w.settle();
        await facadeStop(w, "marker");
        unreadable(w, kind);
        release();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        expect(where(w, "draft:a")).toEqual(STANDING("marker"));
        expect(w.drafts()[0]?.status).toBe("queued");
      } finally {
        finish(w);
      }
    });

  test("a page that never read the marker (a reload) cannot honour it while the store is unreadable, which it can tell: the answer is `unknown`, and a read that lands restores the stop", async () => {
    const w = await world();
    try {
      await queued(w);
      await facadeStop(w, "marker");
      w.dispatcher.stop();
      // The store is unreadable from the page's FIRST read: nothing has been established here.
      unreadable(w, "getItem");
      w.reload();
      // Assessed and not changed: with no marker read on this page the stop cannot be known, and the claim's own durable write is what
      // guards the send. What this page can say is that it does not know.
      expect(w.markers.probe(scopeOf(account(w)), "draft:a")).toBe("unknown");
      expect(w.markers.inspect(scopeOf(account(w)))).toEqual({
        operations: [],
        known: false,
      });
      readable(w);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(10_000);
      expect(w.sent).toHaveLength(0);
      // The dispatcher reads the markers at its window and says so; the facade, whose first look could not read them, is still unsure
      // (not blind for good) and shows the stop at the first prompt after the records can be read.
      expect(w.dispatcher.state.get().kind).toBe("stopped");
      hint(w);
      await w.settle();
      expect(w.outbox.storageNotResponding.get()).toBe(true);
      expect(where(w, "draft:a")).toEqual(STANDING("marker"));
      w.outbox.retry("a");
      await w.settle();
      await w.advance(10_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
    } finally {
      finish(w);
    }
  });

  for (const mechanism of MECHANISMS)
    test(`${mechanism}: a reload with readable markers restores the stop exactly as before (the durable and marker forms; the memory form is the disclosed limit)`, async () => {
      const w = await world();
      try {
        await queued(w);
        await facadeStop(w, mechanism);
        w.dispatcher.stop();
        w.reload();
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        if (mechanism === "memory") {
          expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        } else {
          expect(w.sent).toHaveLength(0);
          expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
        }
      } finally {
        finish(w);
      }
    });

  test("reads of the markers cost what they cost (adapted, revision 33): a healthy page reads only the directories' fixed addresses, lists nothing, and reads nothing proportional to the queue", async () => {
    const w = await world();
    try {
      await queued(w);
      const calls = { get: 0, key: 0 };
      const get = w.markerStorage.getItem.bind(w.markerStorage);
      const key = w.markerStorage.key.bind(w.markerStorage);
      w.markerStorage.getItem = (k) => {
        calls.get += 1;
        return get(k);
      };
      w.markerStorage.key = (i) => {
        calls.key += 1;
        return key(i);
      };
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      // The claim asks for the draft's two markers, and the receipt's success asks for its own: a handful of observations, each of them
      // the `SLOT_COUNT` addresses of the directories (no failure is listed on a healthy page, so no marker's key is read), and nothing
      // proportional to the queue. The origin's keys are never listed.
      expect(calls.get).toBeLessThanOrEqual(16 * SLOT_COUNT);
      expect(calls.key).toBe(0);
    } finally {
      finish(w);
    }
  });
});

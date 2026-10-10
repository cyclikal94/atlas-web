// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { markInFlight } from "../../src/data/plans/outbox";
import {
  markerStands,
  plantMarker,
  scopeOf,
} from "../support/data/marker-storage";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R46 (revision 28): a stop admits no send, whenever it was recorded and by whichever writer.
 *
 * The dispatcher reads the queue and picks a draft; it then CLAIMS the draft (one transaction) and issues the request. A stop that another
 * writer of the page records in between (the facade's edit of the draft fails three times; or its counter cannot be written and the
 * fallback marker records the stop; or neither can be written and the page's memory holds it) was bypassed: the claim ended the draft's
 * durable streak in the transaction that claimed it, released the memory stop and removed the marker as "its own success" afterwards, and
 * the step that issues the request did not ask, so the draft was sent although nothing had retried, edited or abandoned it. A claim is
 * never the recovery that permits it: it now REFUSES a draft that stands stopped, from the durable streaks of the transaction it runs in
 * and the page's own stops in the same synchronous decision, without touching either; and the step that issues the request asks again
 * (the marker, the page's memory and the announcements of the page, so a stop of any record that another writer of this page recorded
 * since the attempt began is honoured), giving the claim back when one stands.
 *
 * FIXTURE evidence: the production facade, plans and dispatcher over the double of IndexedDB and of `localStorage`; no backend. The
 * delayed answers are `delayResult` (the plan runs at once and its answer is delivered later), which is how a read made before a write is
 * told of after it.
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
type Held = "data.readDispatchWindow" | "data.markInFlight";
const HOLDS: Array<{ plan: Held; label: string }> = [
  { plan: "data.readDispatchWindow", label: "the queue read" },
  { plan: "data.markInFlight", label: "the claim" },
];

const finish = (w: OutboxWorld): void => {
  w.dispatcher.stop();
  w.service.dispose("closed");
};
const account = (w: OutboxWorld): string => w.service.account;
const streaksOf = (w: OutboxWorld): Record<string, number> =>
  w.sync().local_write_streaks;
const where = (w: OutboxWorld, operation: string) => ({
  streak: streaksOf(w)[operation] ?? 0,
  marker: w.markers.operations(scopeOf(account(w))).includes(operation),
  memory: w.markers.stops.operations(w.service).includes(operation),
});
const NOTHING = { streak: 0, marker: false, memory: false };
const STANDING = (mechanism: Mechanism) => ({
  streak: mechanism === "streak" ? 3 : 0,
  marker: mechanism === "marker",
  memory: mechanism === "memory",
});
const fail = (w: OutboxWorld, label: string, times: number) =>
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
/** What the transactions of one plan wrote (a commit that wrote nothing is not counted). */
const written = (w: OutboxWorld, label: string): number =>
  w.env.world.logs.filter(
    (e) => e.type === "idb.commit" && e.label === label && e.wrote === true,
  ).length;
const reads = (w: OutboxWorld, label: string): number =>
  w.env.world.logs.filter((e) => e.type === "idb.commit" && e.label === label)
    .length;

/** The plan named `name` runs at once and its answer is delivered when `release()` is called. */
function delayResult(
  store: OutboxWorld["service"]["store"],
  name: string,
): { release(): void; held(): boolean } {
  const real = store.run.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let armed = true;
  let intercepted = false;
  let release: () => void = () => undefined;
  (store as { run: unknown }).run = (
    plan: { name: string },
    input: unknown,
    options: unknown,
  ) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== name) return answer;
    armed = false;
    intercepted = true;
    return new Promise<unknown>((resolve, reject) => {
      release = () => {
        void answer.then(resolve, reject);
      };
    });
  };
  return { release: () => release(), held: () => intercepted };
}

/** A world with the cached resources the drafts below edit. */
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

/** The facade's own write of `id` fails by `mechanism`: three failures, or one whose counter and then marker cannot be written. */
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

/** `a` (and, when named, `b`) are queued; nothing is sent yet. */
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

/**
 * The dispatcher starts, its answer for `hold` is held, `record` is what another writer does meanwhile, and the answer is released. Nothing
 * is awaited after the release but the world's own settling and a long wait, so any send that is going to happen has happened.
 */
async function stopWhileHeld(
  w: OutboxWorld,
  hold: Held,
  record: () => Promise<void>,
): Promise<void> {
  const late = delayResult(w.service.store, hold);
  w.online = true;
  w.start();
  await w.settle();
  expect(late.held(), `${hold} was reached and its answer is held`).toBe(true);
  await record();
  late.release();
  await w.settle();
  await w.advance(10_000);
}

// ---- the claim and the step that issues the request ---------------------------------------------------------------------------------
describe("R46: a stop recorded after the queue was read admits no send, in every record and at every point before the request", () => {
  for (const hold of HOLDS)
    for (const mechanism of MECHANISMS)
      test(`${mechanism}: recorded while ${hold.label} is held, the draft is not sent and the stop is exactly as it was recorded`, async () => {
        const w = await world();
        try {
          await queued(w);
          await stopWhileHeld(w, hold.plan, () => facadeStop(w, mechanism));
          expect(w.sent).toHaveLength(0);
          // The stop is untouched: a claim that landed ended nothing of it (the record, the marker and the page's memory stand).
          expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
          expect(w.outbox.storageNotResponding.get()).toBe(true);
          expect(w.outbox.storageMemoryOnly.get()).toBe(mechanism === "memory");
          // Nothing of the draft is claimed any more: it is back to queued with no candidate row, and it is left alone.
          expect(w.drafts()[0]?.status).toBe("queued");
          expect(w.effects()).toHaveLength(0);
          expect(w.dispatcher.state.get()).toEqual({
            kind: "stopped",
            cause: "local_storage",
            ...(mechanism === "memory" ? { memoryOnly: true as const } : {}),
          });
        } finally {
          finish(w);
        }
      });

  test("the claim is where it is refused when the stop was recorded before the claim began: it WRITES NOTHING (no claim, no give-back)", async () => {
    for (const mechanism of MECHANISMS) {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, "data.readDispatchWindow", () =>
          facadeStop(w, mechanism),
        );
        expect(w.sent).toHaveLength(0);
        expect(written(w, "data.markInFlight")).toBe(0);
        expect(written(w, "data.unclaimDraft")).toBe(0);
      } finally {
        finish(w);
      }
    }
  });

  test("the step that issues the request is where it is refused when the stop was recorded after the claim landed: the claim is GIVEN BACK, once, and nothing is sent", async () => {
    for (const mechanism of MECHANISMS) {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, "data.markInFlight", () =>
          facadeStop(w, mechanism),
        );
        expect(w.sent).toHaveLength(0);
        expect(written(w, "data.markInFlight")).toBe(1);
        expect(written(w, "data.unclaimDraft")).toBe(1);
      } finally {
        finish(w);
      }
    }
  });

  for (const mechanism of MECHANISMS)
    test(`${mechanism}: the stop that held the draft before the dispatcher started is the same stop (the unheld control)`, async () => {
      const w = await world();
      try {
        await queued(w);
        await facadeStop(w, mechanism);
        w.online = true;
        w.start();
        await w.settle();
        await w.advance(10_000);
        expect(w.sent).toHaveLength(0);
        expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
        expect(written(w, "data.markInFlight")).toBe(0);
      } finally {
        finish(w);
      }
    });

  test("a stop that stands costs no reads and no timers: after the refusal the dispatcher is idle until something is lifted", async () => {
    for (const hold of HOLDS) {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, hold.plan, () => facadeStop(w, "marker"));
        const before = reads(w, "data.readDispatchWindow");
        await w.advance(120_000);
        expect(reads(w, "data.readDispatchWindow")).toBe(before);
        expect(w.sent).toHaveLength(0);
        // A handful of reads at most: the first, the refusal's, and the one that restores the stop.
        expect(before).toBeLessThanOrEqual(4);
      } finally {
        finish(w);
      }
    }
  });
});

// ---- permitted recovery -------------------------------------------------------------------------------------------------------------
describe("R46: what the person or the operation does still lifts the stop the claim refused, and the draft is then sent exactly once", () => {
  const recoveries: Array<{
    name: string;
    run(w: OutboxWorld): Promise<void> | void;
    sends: boolean;
    body?: string;
  }> = [
    {
      name: 'the facade\'s "Try again" for that draft',
      run: (w) => w.outbox.retry("a"),
      sends: true,
    },
    {
      name: 'the facade\'s "Try again" for every draft',
      run: (w) => w.outbox.retry(),
      sends: true,
    },
    {
      name: "the dispatcher's explicit retry of that draft",
      run: (w) => w.dispatcher.retry("a"),
      sends: true,
    },
    {
      name: "the dispatcher's explicit retry of every draft",
      run: (w) => w.dispatcher.retry(),
      sends: true,
    },
    {
      name: "a successful edit of the draft (the operation's own success)",
      run: async (w) => {
        expect(
          (await w.outbox.editQueued("a", request("a", "edited"))).kind,
        ).toBe("edited");
      },
      sends: true,
      body: "edited",
    },
    {
      name: "the discard of the draft (abandoning the operation)",
      run: async (w) => {
        expect((await w.outbox.discard("a")).kind).toBe("discarded");
      },
      sends: false,
    },
  ];
  for (const hold of HOLDS)
    for (const mechanism of MECHANISMS)
      for (const recovery of recoveries)
        test(`${mechanism}, ${hold.label} held: ${recovery.name}`, async () => {
          const w = await world();
          try {
            await queued(w);
            await stopWhileHeld(w, hold.plan, () => facadeStop(w, mechanism));
            expect(w.sent).toHaveLength(0);
            await recovery.run(w);
            await w.settle();
            await w.advance(10_000);
            expect(where(w, "draft:a")).toEqual(NOTHING);
            expect(w.outbox.storageNotResponding.get()).toBe(false);
            if (recovery.sends) {
              expect(w.sent.map((s) => s.key)).toEqual(["a"]);
              if (recovery.body !== undefined)
                expect(w.sent[0]?.body).toContain(recovery.body);
            } else {
              expect(w.sent).toHaveLength(0);
            }
          } finally {
            finish(w);
          }
        });

  for (const mechanism of MECHANISMS)
    test(`${mechanism}: another draft's "Try again" lifts nothing of this draft's stop`, async () => {
      const w = await world();
      try {
        await queued(w, ["a", "b"]);
        await stopWhileHeld(w, "data.readDispatchWindow", () =>
          facadeStop(w, mechanism, "a"),
        );
        w.outbox.retry("b");
        w.dispatcher.retry("b");
        await w.settle();
        await w.advance(10_000);
        expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
        expect(w.sent.map((s) => s.key)).toEqual(["b"]);
      } finally {
        finish(w);
      }
    });

  test("a stop recorded and lifted while the claim was outstanding costs one give-back, and the draft is sent afterwards, once", async () => {
    for (const mechanism of MECHANISMS) {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, "data.markInFlight", async () => {
          await facadeStop(w, mechanism);
          w.outbox.retry("a");
          await w.settle();
          expect(where(w, "draft:a")).toEqual(NOTHING);
        });
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(written(w, "data.unclaimDraft")).toBe(1);
        expect(w.drafts()[0]?.status).toBe("acknowledged");
      } finally {
        finish(w);
      }
    }
  });
});

// ---- the queue read and the claim never spin against each other -----------------------------------------------------------------------
describe("R46: should the queue read and the claim ever disagree about a stop, the dispatcher is paced and never spun", () => {
  for (const mechanism of ["marker", "memory"] as const)
    test(`${mechanism}: a queue read that cannot see the stop and a claim that can: the draft is refused, nothing is written or sent, and the attempts are paced`, async () => {
      const w = await world();
      try {
        await queued(w);
        await facadeStop(w, mechanism);
        // The read of the page's stops (what the window is given) is blind; the claim's own question is not.
        if (mechanism === "marker")
          w.markers.inspect = () => ({ operations: [], known: true });
        else w.markers.stops.operations = () => [];
        w.online = true;
        w.start();
        // A hot loop never lets the world go idle: what is asserted is how often the queue was read and what was written.
        await w.settle().catch(() => undefined);
        await w.advance(10_000).catch(() => undefined);
        expect(reads(w, "data.readDispatchWindow")).toBeLessThanOrEqual(30);
        expect(w.sent).toHaveLength(0);
        expect(written(w, "data.markInFlight")).toBe(0);
        // The stop is still there (the blind question is the window's, so `where` is read through the page's own answer).
        expect(
          mechanism === "marker"
            ? markerStands(w.markerStorage, account(w), "draft:a")
            : w.markers.stops.has(w.service, "draft:a"),
        ).toBe(true);
      } finally {
        finish(w);
      }
    });

  test("the run ends at once when the two agree: a refusal costs one more read of the queue and then nothing (the pacing is for a disagreement only)", async () => {
    const w = await world();
    try {
      await queued(w);
      await facadeStop(w, "marker");
      await stopWhileHeld(w, "data.readDispatchWindow", async () => undefined);
      const before = reads(w, "data.readDispatchWindow");
      await w.advance(120_000);
      expect(reads(w, "data.readDispatchWindow")).toBe(before);
      expect(w.dispatcher.state.get().kind).toBe("stopped");
    } finally {
      finish(w);
    }
  });
});

// ---- a stop that only ANOTHER tab's marker holds ------------------------------------------------------------------------------------
describe("R46: a marker another TAB writes is read where the send is admitted (no announcement tells this page of it)", () => {
  const otherTab = (w: OutboxWorld, operation: string): void => {
    plantMarker(
      w.markerStorage.page("another-tab").storage,
      account(w),
      operation,
      "tab.1",
    );
  };
  for (const operation of ["draft:a", "receipt:a"])
    test(`${operation}: written while the queue read is held, the claim refuses the draft and WRITES NOTHING`, async () => {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, "data.readDispatchWindow", async () =>
          otherTab(w, operation),
        );
        expect(w.sent).toHaveLength(0);
        expect(written(w, "data.markInFlight")).toBe(0);
        expect(written(w, "data.unclaimDraft")).toBe(0);
        expect(w.drafts()[0]?.status).toBe("queued");
        expect(markerStands(w.markerStorage, account(w), operation)).toBe(true);
      } finally {
        finish(w);
      }
    });

  for (const operation of ["draft:a", "receipt:a"])
    test(`${operation}: written after the claim landed (nothing announces it), the step that issues the request gives the claim back`, async () => {
      const w = await world();
      try {
        await queued(w);
        await stopWhileHeld(w, "data.markInFlight", async () =>
          otherTab(w, operation),
        );
        expect(w.sent).toHaveLength(0);
        expect(written(w, "data.markInFlight")).toBe(1);
        expect(written(w, "data.unclaimDraft")).toBe(1);
        expect(w.drafts()[0]?.status).toBe("queued");
        expect(markerStands(w.markerStorage, account(w), operation)).toBe(true);
      } finally {
        finish(w);
      }
    });
});

// ---- exact-operation isolation ------------------------------------------------------------------------------------------------------
describe("R46: the stop that is enforced is the draft's own: another draft's, another operation's and a below-bound count are not", () => {
  for (const hold of HOLDS)
    for (const mechanism of MECHANISMS)
      test(`${mechanism}, ${hold.label} held: a stop of ANOTHER draft recorded meanwhile holds that draft and sends this one`, async () => {
        const w = await world();
        try {
          await queued(w, ["a", "b"]);
          await stopWhileHeld(w, hold.plan, () =>
            facadeStop(w, mechanism, "b"),
          );
          expect(w.sent.map((s) => s.key)).toEqual(["a"]);
          expect(where(w, "draft:b")).toEqual(STANDING(mechanism));
          expect(w.drafts().find((d) => d.local_id === "b")?.status).toBe(
            "queued",
          );
        } finally {
          finish(w);
        }
      });

  for (const hold of HOLDS)
    for (const mechanism of MECHANISMS)
      test(`${mechanism}, ${hold.label} held: a stop of the draft's RECEIPT operation recorded meanwhile holds the draft too (both of its operations are its)`, async () => {
        const w = await world();
        try {
          await queued(w);
          await stopWhileHeld(w, hold.plan, async () => {
            if (mechanism === "marker")
              expect(
                w.markers.set(scopeOf(account(w)), "receipt:a").state,
              ).toBe("recorded");
            else if (mechanism === "memory")
              w.markers.stops.hold(w.service, "receipt:a");
            else
              w.setSync({
                local_write_streaks: {
                  ...streaksOf(w),
                  "receipt:a": 3,
                },
              });
            // Another writer of the page says so, as the dispatcher's own failure of a receipt would.
            w.markers.stops.announce(
              w.service,
              {},
              { recorded: ["receipt:a"] },
            );
          });
          expect(w.sent).toHaveLength(0);
          expect(where(w, "receipt:a")).toEqual(STANDING(mechanism));
        } finally {
          finish(w);
        }
      });

  test("a stop of an operation that names no draft of this attempt (a page, the queue read) is not a draft's stop", async () => {
    const w = await world();
    try {
      await queued(w);
      await stopWhileHeld(w, "data.markInFlight", async () => {
        w.markers.set(scopeOf(account(w)), "page:cursor-0");
        w.markers.stops.hold(w.service, "capture");
        w.markers.stops.announce(
          w.service,
          {},
          { recorded: ["page:cursor-0", "capture", "draft:ba"] },
        );
      });
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(written(w, "data.unclaimDraft")).toBe(0);
    } finally {
      finish(w);
    }
  });

  test("a claim that failed once and then landed leaves the dispatcher nothing to clear: an explicit retry writes no streak", async () => {
    const w = await world();
    try {
      await queued(w);
      fail(w, "data.markInFlight", 1);
      w.online = true;
      w.start();
      await w.settle();
      await w.advance(1_000);
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      const before = reads(w, "data.recordLocalWriteOutcome");
      w.dispatcher.retry();
      await w.settle();
      expect(reads(w, "data.recordLocalWriteOutcome")).toBe(before);
    } finally {
      finish(w);
    }
  });

  test("a below-bound count is not a stop: the claim that lands ends it, as before (three isolated aborts are not three in a row)", async () => {
    const w = await world();
    try {
      await queued(w);
      fail(w, "data.editQueuedDraft", 2);
      for (let i = 0; i < 2; i += 1)
        expect((await w.outbox.editQueued("a", request("a", "x"))).kind).toBe(
          "refused",
        );
      expect(streaksOf(w)["draft:a"]).toBe(2);
      expect(w.outbox.storageNotResponding.get()).toBe(false);
      w.online = true;
      w.start();
      await w.settle();
      expect(w.sent.map((s) => s.key)).toEqual(["a"]);
      expect(streaksOf(w)["draft:a"]).toBeUndefined();
    } finally {
      finish(w);
    }
  });

  for (const mechanism of MECHANISMS)
    test(`${mechanism}: a draft that is already \`in_flight\` (a retry candidate, resent under its own key) is held by a stop recorded after the read as well, and is resent when it is lifted`, async () => {
      const w = await world();
      try {
        await queued(w);
        w.script.push(w.error(503, "unavailable"));
        w.online = true;
        w.start();
        await w.settle();
        expect(w.sent.map((s) => s.key)).toEqual(["a"]);
        expect(w.drafts()[0]?.status).toBe("in_flight");
        // The durable back-off has run out when the dispatcher looks again, and the queue read is held.
        w.dispatcher.stop();
        await w.advance(120_000);
        await stopWhileHeld(w, "data.readDispatchWindow", () =>
          facadeStop(w, mechanism),
        );
        expect(w.sent).toHaveLength(1);
        expect(where(w, "draft:a")).toEqual(STANDING(mechanism));
        expect(w.drafts()[0]?.status).toBe("in_flight");
        w.outbox.retry("a");
        await w.settle();
        await w.advance(10_000);
        expect(w.sent.map((s) => s.key)).toEqual(["a", "a"]);
        expect(where(w, "draft:a")).toEqual(NOTHING);
      } finally {
        finish(w);
      }
    });
});

// ---- the claim plan itself ----------------------------------------------------------------------------------------------------------
describe("R46: markInFlight refuses a stopped draft in its own transaction and leaves the stop exactly as it found it", () => {
  async function claim(
    w: OutboxWorld,
    localId: string,
    heldOutside?: (localId: string) => boolean,
  ) {
    return w.service.commit(markInFlight, {
      captured: w.capture(),
      localId,
      ...(heldOutside === undefined ? {} : { heldOutside }),
    });
  }

  for (const operation of ["draft:a", "receipt:a"])
    test(`a durable count of ${operation} at the bound refuses the claim and is NOT cleared (nothing is written)`, async () => {
      const w = await world();
      try {
        await queued(w);
        w.setSync({ local_write_streaks: { [operation]: 3 } });
        const before = written(w, "data.markInFlight");
        expect(await claim(w, "a")).toEqual({
          kind: "applied",
          value: { kind: "stopped" },
        });
        expect(written(w, "data.markInFlight")).toBe(before);
        expect(streaksOf(w)[operation]).toBe(3);
        expect(w.drafts()[0]?.status).toBe("queued");
        expect(w.effects()).toHaveLength(0);
      } finally {
        finish(w);
      }
    });

  test("a count one below the bound is claimed, and the claim ends it (the failures were not consecutive)", async () => {
    const w = await world();
    try {
      await queued(w);
      w.setSync({ local_write_streaks: { "draft:a": 2, "draft:b": 2 } });
      expect(await claim(w, "a")).toMatchObject({
        kind: "applied",
        value: { kind: "claimed" },
      });
      expect(streaksOf(w)).toEqual({ "draft:b": 2 });
    } finally {
      finish(w);
    }
  });

  test("another draft's count at the bound is no obstacle, and a draft whose id merely ENDS a stopped one's is not that draft", async () => {
    const w = await world();
    try {
      await queued(w);
      w.setSync({ local_write_streaks: { "draft:b": 3, "draft:ba": 3 } });
      expect(await claim(w, "a")).toMatchObject({
        value: { kind: "claimed" },
      });
    } finally {
      finish(w);
    }
  });

  test("a stop the database does not hold refuses the claim through `heldOutside`, which is asked for the draft being claimed, in the decision", async () => {
    const w = await world();
    try {
      await queued(w);
      const asked: string[] = [];
      expect(
        await claim(w, "a", (id) => {
          asked.push(id);
          return true;
        }),
      ).toEqual({ kind: "applied", value: { kind: "stopped" } });
      expect(asked).toEqual(["a"]);
      expect(written(w, "data.markInFlight")).toBe(0);
      expect(w.drafts()[0]?.status).toBe("queued");
      expect(await claim(w, "a", () => false)).toMatchObject({
        value: { kind: "claimed" },
      });
    } finally {
      finish(w);
    }
  });

  test("without `heldOutside` only the durable record is consulted, and a draft that is gone or not sendable keeps its own answer", async () => {
    const w = await world();
    try {
      await queued(w);
      expect(await claim(w, "missing", () => true)).toEqual({
        kind: "applied",
        value: { kind: "gone" },
      });
      expect(await claim(w, "a")).toMatchObject({ value: { kind: "claimed" } });
    } finally {
      finish(w);
    }
  });
});

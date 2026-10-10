// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
  type QuotaReservation,
} from "../../src/data/engine/quota-guard";
import { DATA_CONFIG, maxResponseBytesFor } from "../../src/data/model/config";
import { createOutbox } from "../../src/data/outbox/outbox";
import { engineWorld } from "../support/data/engine-world";
import { fakeOrigin } from "../support/data/origin-ledger";
import { uuid } from "../support/data/sync-pages";

/**
 * R28 (revision 14): a cache page is admitted against the origin's free space where it is committed, and held through its commit, like
 * the saves it competes with.
 *
 * The review's schedule: the engine's admission was `quota.check`, which holds nothing, and `applyPage` committed the response without a
 * reservation or another growth admission. While a `/sync` response was outstanding, ten public saves of 1 MiB were admitted into the free
 * space (19,513,344 bytes: the reserve plus the largest page of limit 1); the page then committed 800 projections of 8,000 bytes and
 * moved its cursor, and the bodies alone left 2,627,584 bytes, below even the input floor (4,194,304). The engine, the outbox and the
 * guards here are the production ones, over the store double and a model of the origin's ledger; the free space is an injected figure.
 * FIXTURE evidence: nothing here is a physical allocation, and the generic command fixture is not a claim about a released backend.
 */
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const MIB = 1024 * 1024;

const person = (n: number, size = 8_000) => ({
  kind: "upsert" as const,
  resource: {
    id: uuid(10_000 + n),
    kind: "person",
    parent_id: null,
    label: "Person",
    value: { text: "a".repeat(size) },
    version: 1,
    can_edit: true,
    archived: false,
  },
});

const save = (n: number, size = MIB) => ({
  localId: uuid(1_000 + n),
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: { kind: "create", text: "x".repeat(size) } }),
});

type World = Awaited<ReturnType<typeof engineWorld>>;

/** An engine whose guard is page A's of an origin, and an outbox of ANOTHER page (B) over the same database and the same origin. */
async function pages(free: number) {
  const w = await engineWorld();
  const origin = fakeOrigin();
  const clock = { t: 0 };
  const guard = (name: string): QuotaGuard =>
    createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: free }) },
      now: () => clock.t,
      ledger: origin.page(name).ledger,
    });
  Object.assign(w.quota, guard("A"));
  const outbox = createOutbox({
    service: w.service,
    quota: guard("B"),
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });
  return { w, origin, outbox, clock };
}

/** The `/sync` request is issued and its response is held; the caller releases it with the page it wants. */
async function holdResponse(w: World) {
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  w.script.push(() => response);
  w.start();
  await w.settle();
  expect(w.requests).toHaveLength(1);
  return release;
}

const cacheBytes = (w: World): number =>
  w
    .cache()
    .reduce(
      (n: number, row: { value?: { text?: string } | null }) =>
        n + (row.value?.text?.length ?? 0),
      0,
    );

describe("the review's schedule: saves made while the response is held, then the page", () => {
  const FREE = RESERVE + maxResponseBytesFor(1);

  // The page needs the reserve and its own 6.5 MB; each 1 MiB save takes about 1.06 MB of the 19.5 MB first: up to four saves leave it room,
  // five do not.
  for (const [saves, committed] of [
    [0, true],
    [3, true],
    [5, false],
    [10, false],
  ] as const)
    test(`${saves} saves of 1 MiB, then a page of 800 x 8,000 bytes: ${
      committed
        ? "there is room for both, and both are written"
        : "the saves were admitted, so the PAGE is the one refused, and the floor holds"
    }`, async () => {
      const { w, origin, outbox } = await pages(FREE);
      const release = await holdResponse(w);
      const results = [];
      for (let i = 0; i < saves; i += 1)
        results.push(await outbox.enqueue(save(i)));
      expect(results.every((result) => result.kind === "queued")).toBe(true);
      release(
        w.json({
          nextCursor: "after-race",
          batches: [
            {
              revision: 1,
              changes: Array.from({ length: 800 }, (_, i) => person(i)),
            },
          ],
        }),
      );
      await w.settle();
      const state = w.state();
      w.engine.stop();
      const remaining = FREE - cacheBytes(w) - saves * MIB;
      expect(remaining).toBeGreaterThanOrEqual(FLOOR);
      if (committed) {
        expect(w.cache()).toHaveLength(800);
        expect(w.sync().cursor).toBe("after-race");
      } else {
        expect(w.cache()).toHaveLength(0);
        expect(w.sync().cursor).not.toBe("after-race");
        expect(state).toMatchObject({ kind: "stopped", cause: "storage_full" });
      }
      // Nothing is left promised, whichever way it went.
      expect(origin.state().holds).toEqual({});
    });

  test("the page first, then the saves: the page is committed and the saves are admitted down to the floor, and refused beyond it", async () => {
    const { w, origin, outbox } = await pages(FREE);
    const release = await holdResponse(w);
    release(
      w.json({
        nextCursor: "after-race",
        batches: [
          {
            revision: 1,
            changes: Array.from({ length: 800 }, (_, i) => person(i)),
          },
        ],
      }),
    );
    await w.settle();
    w.engine.stop();
    expect(w.cache()).toHaveLength(800);
    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await outbox.enqueue(save(i)));
    const queued = results.filter((result) => result.kind === "queued").length;
    expect(queued).toBeGreaterThan(0);
    expect(queued).toBeLessThan(20);
    expect(
      results.filter((result) => result.kind !== "queued").length,
    ).toBeGreaterThan(0);
    expect(FREE - cacheBytes(w) - queued * MIB).toBeGreaterThanOrEqual(FLOOR);
    expect(origin.state().holds).toEqual({});
  });
});

describe("the admission is the commit's own, and every way it ends releases it", () => {
  const FREE = RESERVE + maxResponseBytesFor(1) + 4 * MIB;
  const page = () => ({
    nextCursor: "after-page",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 50 }, (_, i) => person(i, 4_000)),
      },
    ],
  });

  test("the hold stands in the origin's ledger when the commit transaction begins, and the landed bytes are recorded when it ends", async () => {
    const { w, origin } = await pages(FREE);
    const seen: number[][] = [];
    w.env.idb.inject({
      match: (tx: { label?: string }) => {
        if (tx.label === "data.commitPage")
          seen.push(Object.values(origin.state().holds).map((h) => h.bytes));
        return false;
      },
      mode: "error",
      times: 1,
    });
    const body = w.json(page());
    const length = (await body.clone().arrayBuffer()).byteLength;
    w.script.push(body);
    w.start();
    await w.settle();
    w.engine.stop();
    expect(w.sync().cursor).toBe("after-page");
    // The page's own size, held while it was committed (and nothing else of the engine's was held).
    expect(seen).toEqual([[length]]);
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBe(length);
  });

  test("a page the quota refuses at the commit stops the engine as `storage_full`, leaves no sizing marker, and writes nothing", async () => {
    // Room for the largest page of the limit (the request's check passes); a 5 MiB save then takes what the page needed.
    const { w, origin, outbox } = await pages(RESERVE + maxResponseBytesFor(1));
    const release = await holdResponse(w);
    expect((await outbox.enqueue(save(0, 5 * MIB))).kind).toBe("queued");
    release(
      w.json({
        nextCursor: "after-race",
        batches: [
          {
            revision: 1,
            changes: Array.from({ length: 800 }, (_, i) => person(i)),
          },
        ],
      }),
    );
    await w.settle();
    const state = w.state();
    w.engine.stop();
    expect(state).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.cache()).toHaveLength(0);
    expect(w.sync().cursor).not.toBe("after-race");
    // A page of 256 KiB or more writes the crash-loop marker before it is processed; a refused page was never attempted, so the next
    // start does not read it as a tab that did not survive (which would step the page size down for want of space).
    expect(w.sync().sizing.attempt).toBeNull();
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed?.landed).toBeGreaterThanOrEqual(5 * MIB);
  });

  test("a commit that FAILS releases the hold without recording the bytes as landed", async () => {
    const { w, origin } = await pages(FREE);
    w.env.idb.inject({
      match: (tx: { label?: string }) => tx.label === "data.commitPage",
      mode: "error",
      times: 100,
    });
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    w.engine.stop();
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
  });

  test("a commit the quota itself fails (a genuine `quota` failure of the store) releases the hold and stops as `storage_full`", async () => {
    const { w, origin } = await pages(FREE);
    w.env.idb.inject({
      match: (tx: { label?: string }) => tx.label === "data.commitPage",
      mode: "quota",
      times: 100,
    });
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    const state = w.state();
    w.engine.stop();
    expect(state).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(origin.state().holds).toEqual({});
    expect(origin.state().landed).toBeNull();
  });

  for (const [name, answer] of [
    [
      "a 410",
      (w: World) => w.status(410, { body: { code: "resync_required" } }),
    ],
    ["a 503", (w: World) => w.status(503)],
    [
      "a page that is not a page",
      (w: World) => w.status(200, { body: { no: "page" } }),
    ],
  ] as const)
    test(`${name} takes no admission at all: nothing is held, written or landed`, async () => {
      const { w, origin } = await pages(FREE);
      w.script.push(answer(w));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(origin.writes()).toBe(0);
      expect(origin.state().holds).toEqual({});
    });
});

/**
 * The review's delayed-save schedule for a CACHE PAGE: the page's commit is held immediately before its transaction (a slow persistence
 * hold, a busy database), the clock moves the 30,001 ms of the production lease, and an input save is admitted into the room the lapsed
 * hold had counted. Unexpired, the page's hold refuses that save and the page commits; expired, the save is admitted and written, and the
 * page, which must be admitted again, is refused: committing it on its old admission would leave the origin below the input floor.
 * The guards are the production ones over the origin's ledger model, the clock is the test's, and the lease is the production constant.
 */
describe("a cache page whose commit is delayed past its lease is admitted again, not committed on the old admission", () => {
  const SAVE = 9 * MIB;
  const page = {
    nextCursor: "after-page",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 800 }, (_, i) => person(i)),
      },
    ],
  };
  /**
   * `owners: false` is a ledger whose holds are reclaimed by their leases alone (revision 14's semantics): the lapsed hold is counted as
   * free. With owners (the production semantics since revision 15) a writer that is only DELAYED, not gone, keeps its hold.
   */
  async function delayed(expired: boolean, owners = false) {
    const w = await engineWorld();
    const origin = fakeOrigin();
    const clock = { t: 0 };
    const body = w.json(page);
    const length = (await body.clone().arrayBuffer()).byteLength;
    // Room for the largest page of the limit above the reserve (the engine's early check passes), so for this page and, if its hold has
    // ended, a 9 MiB save that would take the origin below the input floor were the page also committed.
    const free = RESERVE + maxResponseBytesFor(1);
    const guard = (name: string): QuotaGuard =>
      createQuotaGuard({
        storage: { estimate: async () => ({ usage: 0, quota: free }) },
        now: () => clock.t,
        ledger: origin.page(name, { owners }).ledger,
      });
    Object.assign(w.quota, guard("A"));
    const outbox = createOutbox({
      service: w.service,
      quota: guard("B"),
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => 0, iso: () => new Date(0).toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    });
    // The page's commit is held just before its transaction begins.
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = w.service.store as unknown as {
      run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
    };
    const run = store.run.bind(store);
    store.run = async (plan, ...rest) => {
      if (plan.name === "data.commitPage") {
        entered();
        await gate;
      }
      return run(plan, ...rest);
    };
    w.script.push(body);
    w.start();
    await reached;
    clock.t = expired ? DATA_CONFIG.quotaHoldLeaseMs + 1 : 1;
    const outcome = await outbox.enqueue(save(0, SAVE));
    release();
    await w.settle();
    const state = w.state();
    w.engine.stop();
    return { w, origin, outcome, state, free, length };
  }

  test("the lease stands: the save is refused (the page's bytes are held), and the page commits", async () => {
    const { w, outcome, free, length } = await delayed(false);
    expect(outcome).toEqual({ kind: "refused", reason: "quota" });
    expect(w.cache()).toHaveLength(800);
    expect(w.sync().cursor).toBe("after-page");
    expect(free - length).toBeGreaterThanOrEqual(FLOOR);
  });

  test("(adapted, revision 16) (a ledger without owners) the lease ran out (clock +30,001 ms): the lapsed hold's bytes are not forgotten but land for one estimate lifetime, so the save is refused AND the page, admitted again, finds its own lapsed promise counted: nothing is written, and the floor holds", async () => {
    // Revision 14's outcome (kept in `.agtx/evidence/WEB-09a/revision-16/adapted/original/`): the lapsed hold was DELETED, so the save was
    // admitted and written (9 MiB) and the page, admitted again, was refused (`stopped / storage_full`). A lapsed lease says the page
    // stopped answering, not that it wrote nothing, so the hold now lands (`landHold`): the save is refused for want of the room it
    // would have taken, and the page's re-admission is counted against its own ghost until the estimate lifetime ends. This is the
    // price of a ledger WITHOUT owners (production always has them: with owners a delayed page keeps its hold and commits, below).
    const { w, origin, outcome, state, free } = await delayed(true);
    expect(outcome).toEqual({ kind: "refused", reason: "quota" });
    expect(w.cache()).toHaveLength(0);
    expect(w.sync().cursor).not.toBe("after-page");
    expect(state).toMatchObject({ kind: "stopped", cause: "storage_full" });
    // Nothing was written, so the origin is as free as it was, and the debit is the only trace.
    expect(free).toBeGreaterThanOrEqual(FLOOR);
    expect(origin.state().holds).toEqual({});
  });

  test("(a ledger with owners, R28 revision 15) the lease ran out (clock +30,001 ms) under a page that is only DELAYED: its hold is not reclaimed, the save is refused, and the page commits: the floor holds", async () => {
    const { w, origin, outcome, free, length } = await delayed(true, true);
    expect(outcome).toEqual({ kind: "refused", reason: "quota" });
    expect(w.cache()).toHaveLength(800);
    expect(w.sync().cursor).toBe("after-page");
    expect(free - length).toBeGreaterThanOrEqual(FLOOR);
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });

  test("the control: with room for the page AND the save, a hold that ran out costs nothing: both are written", async () => {
    // The same schedule with 10 MiB more room: the re-admission of the page succeeds.
    const w = await engineWorld();
    const origin = fakeOrigin();
    const clock = { t: 0 };
    const body = w.json(page);
    const free = RESERVE + maxResponseBytesFor(1) + 10 * MIB;
    const guard = (name: string): QuotaGuard =>
      createQuotaGuard({
        storage: { estimate: async () => ({ usage: 0, quota: free }) },
        now: () => clock.t,
        ledger: origin.page(name).ledger,
      });
    Object.assign(w.quota, guard("A"));
    const outbox = createOutbox({
      service: w.service,
      quota: guard("B"),
      ids: { uuid: () => crypto.randomUUID() },
      clock: { now: () => 0, iso: () => new Date(0).toISOString() },
      fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = w.service.store as unknown as {
      run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
    };
    const run = store.run.bind(store);
    store.run = async (plan, ...rest) => {
      if (plan.name === "data.commitPage") {
        entered();
        await gate;
      }
      return run(plan, ...rest);
    };
    w.script.push(body);
    w.start();
    await reached;
    clock.t = DATA_CONFIG.quotaHoldLeaseMs + 1;
    expect((await outbox.enqueue(save(0, SAVE))).kind).toBe("queued");
    release();
    await w.settle();
    w.engine.stop();
    expect(w.cache()).toHaveLength(800);
    expect(w.sync().cursor).toBe("after-page");
    expect(origin.state().holds).toEqual({});
  });
});

/**
 * R28 (revision 15): a page whose admission could not be ESTABLISHED (the origin's ledger would not answer) is not a page the quota refused.
 * Nothing is known to be full, so the engine must not stop with the storage-full notice (which asks the person to free space): it applies
 * nothing, counts no failure, asks for the page again on its paced schedule, and commits once the ledger answers. The engine, the plans
 * and the guard are the production ones over the origin's ledger model; the ledger failing is a named injection.
 */
describe("an admission the ledger could not answer is not a storage stop", () => {
  const FREE = RESERVE + maxResponseBytesFor(1) + 10 * MIB;
  const body = {
    nextCursor: "after-page",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 800 }, (_, i) => person(i)),
      },
    ],
  };

  test("the page is requested again, paced, and committed once the ledger answers; the notice never says the storage is full", async () => {
    const { w, origin } = await pages(FREE);
    origin.fail("A", 1_000);
    w.script.push(w.json(body));
    w.script.push(w.json(body));
    w.start();
    // The guard waits between its tries in REAL time (20, 40 and 80 ms), which the world's own clock does not drive: wait for the page's
    // admission to have been refused (the early check's two tries, the reservation's four, and the one removal of a hold that a lost
    // answer might have left).
    await vi.waitFor(() =>
      expect(origin.rejected("A")).toBe(
        2 + DATA_CONFIG.quotaLedgerAttempts + 1,
      ),
    );
    await w.settle();
    // Not a stop of any kind, nothing was applied, and nothing counts as a failure of this page.
    expect(w.requests).toHaveLength(1);
    expect(w.state().kind).not.toBe("stopped");
    expect(w.cache()).toHaveLength(0);
    expect(w.sync().cursor).not.toBe("after-page");
    // The ledger answers again; the page is asked for again on the engine's paced schedule and committed under a real admission.
    origin.heal("A");
    await w.advance(120_000);
    await w.settle();
    // The page again (and, the cache now being current, the engine goes on asking for what follows it).
    expect(w.requests.length).toBeGreaterThanOrEqual(2);
    expect(w.state().kind).not.toBe("stopped");
    expect(w.cache()).toHaveLength(800);
    expect(w.sync().cursor).not.toBe("cursor-0");
    expect(origin.state().holds).toEqual({});
    w.engine.stop();
  });

  test("the control: a refusal for want of space IS the storage stop (the ledger answered; the space is short)", async () => {
    const { w } = await pages(RESERVE + maxResponseBytesFor(1));
    // Room for the largest page of the limit (the early check passes) but not for a 9 MiB hold that is already there.
    const other = fakeOrigin();
    const guard = createQuotaGuard({
      storage: {
        estimate: async () => ({
          usage: 0,
          quota: RESERVE + maxResponseBytesFor(1),
        }),
      },
      now: () => 0,
      ledger: other.page("Z").ledger,
    });
    await guard.reserve("input", 9 * MIB);
    Object.assign(w.quota, guard);
    w.script.push(w.json(body));
    w.start();
    await w.settle();
    expect(w.state()).toMatchObject({ kind: "stopped", cause: "storage_full" });
    w.engine.stop();
  });
});

describe("an estimate that is unavailable never refuses a page", () => {
  test("`unknown`: the page is committed under a reservation that is settled as written", async () => {
    const w = await engineWorld();
    w.freeBytes = null;
    const settled: string[] = [];
    const guard = w.quota;
    const reserve = guard.reserve.bind(guard);
    guard.reserve = async (kind, bytes) => {
      const reservation = await reserve(kind, bytes);
      return {
        ...reservation,
        settle: (outcome) => {
          settled.push(`${reservation.verdict}:${outcome}`);
          reservation.settle(outcome);
        },
      };
    };
    w.script.push(
      w.json({
        nextCursor: "after-page",
        batches: [
          {
            revision: 1,
            changes: Array.from({ length: 5 }, (_, i) => person(i)),
          },
        ],
      }),
    );
    w.start();
    await w.settle();
    w.engine.stop();
    expect(settled).toEqual(["unknown:written"]);
    expect(w.cache()).toHaveLength(5);
  });
});

describe("the page is committed only while its hold stands", () => {
  /** A guard whose reservations are live or lapsed as scripted, and which records what it was asked and what was settled. */
  function scripted(lapses: number) {
    const asked: Array<[string, number]> = [];
    const settled: string[] = [];
    let made = 0;
    const quota = {
      check: async () => "ok",
      reserve: async (
        kind: string,
        bytes: number,
      ): Promise<QuotaReservation> => {
        asked.push([kind, bytes]);
        made += 1;
        const mine = made;
        return {
          verdict: "ok",
          live: () => mine > lapses,
          settle: (outcome) => {
            settled.push(`${mine}:${outcome}`);
          },
        };
      },
      lastFree: () => null,
      invalidate: () => undefined,
    } as unknown as QuotaGuard;
    return { quota, asked, settled };
  }
  const page = () => ({
    nextCursor: "after-page",
    batches: [
      { revision: 1, changes: Array.from({ length: 5 }, (_, i) => person(i)) },
    ],
  });

  test("a hold that ended once: the page is admitted again at its own size and committed under the second", async () => {
    const w = await engineWorld();
    const probe = scripted(1);
    Object.assign(w.quota, probe.quota);
    const body = w.json(page());
    const length = (await body.clone().arrayBuffer()).byteLength;
    w.script.push(body);
    w.start();
    await w.settle();
    w.engine.stop();
    expect(probe.asked).toEqual([
      ["cache", length],
      ["cache", length],
    ]);
    expect(probe.settled).toEqual(["1:not_written", "2:written"]);
    expect(w.sync().cursor).toBe("after-page");
    expect(w.cache()).toHaveLength(5);
  });

  test("holds that end on all three admissions: nothing is written, nothing is counted as a failure, and the page is requested again, paced", async () => {
    const w = await engineWorld();
    const probe = scripted(3);
    Object.assign(w.quota, probe.quota);
    w.script.push(w.json(page()));
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(probe.settled).toEqual([
      "1:not_written",
      "2:not_written",
      "3:not_written",
    ]);
    expect(w.sync().cursor).not.toBe("after-page");
    expect(w.requests).toHaveLength(1);
    // The pacing of a commit that could not be verified (one delay, not a spin), then the page is requested again and committed.
    await w.advance(DATA_CONFIG.backoffMaxMs);
    expect(w.requests.length).toBeGreaterThanOrEqual(2);
    expect(w.sync().cursor).toBe("after-page");
    w.engine.stop();
  });

  test("a hold that ended after the crash-loop marker was written, and an admission that is then refused, leaves no marker (a refusal for want of space is not a tab that did not survive)", async () => {
    const w = await engineWorld();
    const settled: string[] = [];
    let made = 0;
    Object.assign(w.quota, {
      check: async () => "ok",
      reserve: async (): Promise<QuotaReservation> => {
        made += 1;
        const mine = made;
        return {
          // The first admission is granted and its hold has already ended; the second is refused.
          verdict: mine === 1 ? "ok" : "refuse",
          live: () => false,
          settle: (outcome) => {
            settled.push(`${mine}:${outcome}`);
          },
        };
      },
    });
    // A page of 256 KiB or more writes the marker before it is processed.
    w.script.push(
      w.json({
        nextCursor: "after-page",
        batches: [
          {
            revision: 1,
            changes: Array.from({ length: 100 }, (_, i) => person(i, 8_000)),
          },
        ],
      }),
    );
    w.start();
    await w.settle();
    const state = w.state();
    w.engine.stop();
    // The refused admission holds nothing and settles nothing.
    expect(settled).toEqual(["1:not_written"]);
    expect(state).toMatchObject({ kind: "stopped", cause: "storage_full" });
    expect(w.cache()).toHaveLength(0);
    expect(w.sync().sizing.attempt).toBeNull();
    // The ladder did not move for want of space.
    expect(w.sync().sizing.limit).toBe(
      (await engineWorld()).sync().sizing.limit,
    );
  });

  test("a run that ended while the admission was awaited commits nothing and releases the reservation (R27)", async () => {
    const w = await engineWorld();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled: string[] = [];
    Object.assign(w.quota, {
      check: async () => "ok",
      reserve: async (): Promise<QuotaReservation> => {
        await gate;
        return {
          verdict: "ok",
          live: () => true,
          settle: (outcome) => {
            settled.push(outcome);
          },
        };
      },
    });
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);
    w.engine.stop();
    release();
    await w.settle();
    expect(settled).toEqual(["not_written"]);
    expect(w.sync().cursor).not.toBe("after-page");
    expect(w.cache()).toHaveLength(0);
  });
});

/**
 * R28 (revision 16) for the engine's page commit, a growth consumer like the saves: the page is committed under a reservation, and once it has
 * landed its bytes must stay counted when the settlement cannot reach the origin's ledger. The review's schedule for the outbox was two
 * rejected settlement calls, the owner letting go, a healthy page proving it and removing the hold, and a second write admitted into room that
 * the first had already filled; the cache page takes the same road through `admitAndCommit`.
 */
describe("a page that committed, whose settlement does not reach the ledger, keeps its bytes counted (R28, revision 16)", () => {
  const FREE = RESERVE + maxResponseBytesFor(1);
  const page = {
    nextCursor: "after-page",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 800 }, (_, i) => person(i)),
      },
    ],
  };

  for (const failures of [0, 2, 1_000])
    test(`${
      failures === 0
        ? "the control: a healthy settlement"
        : failures === 2
          ? "two settlement calls rejected (the review's schedule)"
          : "every settlement call rejected until the ledger heals"
    }: a save that would not fit beside the page is refused, and a small one is admitted`, async () => {
      const { w, origin, outbox } = await pages(FREE);
      // The page's reservation is made; the next call of its ledger is the settlement of its commit.
      const reserve = w.quota.reserve.bind(w.quota);
      Object.assign(w.quota, {
        reserve: async (kind: "input" | "cache", bytes: number) => {
          const reservation = await reserve(kind, bytes);
          if (failures > 0) origin.fail("A", failures);
          return reservation;
        },
      });
      const body = w.json(page);
      const length = (await body.clone().arrayBuffer()).byteLength;
      w.script.push(body);
      w.start();
      await w.settle();
      w.engine.stop();
      expect(w.cache()).toHaveLength(800);
      // Room above the floor after the page: a save larger than that fits the origin only if the page's bytes were forgotten.
      const big = FREE - FLOOR - length + 500_000;
      expect(await outbox.enqueue(save(0, big))).toEqual({
        kind: "refused",
        reason: "quota",
      });
      origin.heal("A");
      await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
      expect(origin.state().holds).toEqual({});
      expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(length);
      expect(await outbox.enqueue(save(1, big))).toEqual({
        kind: "refused",
        reason: "quota",
      });
      // The control: the page's bytes do not turn away what fits beside them.
      expect((await outbox.enqueue(save(2, 100_000))).kind).toBe("queued");
    });
});

describe("a page that opens late over a debit it did not see land asks again, paced, and does not stop with a storage notice (R28b, revision 18)", () => {
  const TTL = DATA_CONFIG.quotaEstimateTtlMs;
  const FREE = RESERVE + maxResponseBytesFor(1) + 100_000;
  const page = {
    nextCursor: "after-late",
    batches: [
      {
        revision: 1,
        changes: Array.from({ length: 800 }, (_, i) => person(i)),
      },
    ],
  };

  /** The origin's debit of a write another page landed long ago and nobody has retired; the engine's guard begins afterwards. */
  async function late(landed: number) {
    const w = await engineWorld();
    const origin = fakeOrigin();
    const clock = { t: 0 };
    const guard = (name: string): QuotaGuard =>
      createQuotaGuard({
        storage: { estimate: async () => ({ usage: 0, quota: FREE }) },
        now: () => clock.t,
        ledger: origin.page(name).ledger,
      });
    const writer = guard("A");
    const held = await writer.reserve("input", landed);
    expect(held.verdict).toBe("ok");
    held.settle("written");
    await vi.waitFor(() => {
      expect(origin.state().holds).toEqual({});
      expect(origin.state().landed?.landed).toBe(landed);
    });
    writer.close?.();
    // Time passes (and a clock may have been set); the engine's page begins only now.
    clock.t = 100_000;
    Object.assign(w.quota, guard("B"));
    return { w, origin, clock };
  }

  test("the early check does not stop the engine on the page's lack of knowledge: the request is made, and the page is committed when the debit's stamp allows it", async () => {
    // The debit (5 MB) would put the early check's large allowance beyond the room; by its own stamp it ended long ago.
    const { w, origin } = await late(5_000_000);
    const body = w.json(page);
    w.script.push(body);
    w.start();
    await w.settle();
    expect(w.state()).not.toMatchObject({ cause: "storage_full" });
    expect(w.requests.length).toBeGreaterThanOrEqual(1);
    w.engine.stop();
    expect(origin.state().holds).toEqual({});
  });

  test("a page the guard refuses for want of knowledge is requested again, paced, nothing is applied, and it is committed once the debit has run out; the floor holds throughout", async () => {
    const body = (await engineWorld()).json(page);
    const length = (await body.clone().arrayBuffer()).byteLength;
    // A debit sized so that the page does not fit beside it by the page's own view, and does by the stamp.
    const landed = FREE - RESERVE - length + 50_000;
    const { w, origin, clock } = await late(landed);
    w.script.push(w.json(page));
    w.script.push(w.json(page));
    w.start();
    await w.settle();
    expect(w.state()).not.toMatchObject({ cause: "storage_full" });
    expect(w.cache()).toHaveLength(0);
    expect(w.sync().cursor).not.toBe("after-late");
    expect(FREE - landed - cacheBytes(w)).toBeGreaterThanOrEqual(FLOOR);
    // One lifetime from the page's start the debit has run out for it: the next request's page is admitted and committed.
    clock.t = 100_000 + TTL;
    await w.advance(120_000);
    expect(w.cache()).toHaveLength(800);
    expect(w.sync().cursor).toBe("after-late");
    w.engine.stop();
    expect(origin.state().holds).toEqual({});
  });
});

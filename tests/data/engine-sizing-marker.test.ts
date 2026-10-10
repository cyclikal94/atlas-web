// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { QuotaReservation } from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { SizingOutcome } from "../../src/data/model/sizing";
import {
  captureRequest,
  recordSizingAttempt,
  recordSizingOutcome,
  retireSizingAttempt,
} from "../../src/data/plans/sync-writers";
import { engineWorld } from "../support/data/engine-world";
import { type PageSpec, uuid } from "../support/data/sync-pages";

/**
 * R42 (revision 23): the crash-loop marker is a claim about an UNKNOWN outcome, and it must not outlive the moment an outcome is known.
 *
 * The review's schedule: a response of at least `markerMinBytes` writes `sizing.attempt` before its guarded commit; the persistence hold
 * answered `unavailable`, `AccountService.commit` DROPPED the commit (correctly, as `unverified`), and nothing retired the marker; the next
 * capture read it as `crashed_attempt`, so three safe drops at the lowest rung reached `floor_hits: 3` and `stopped / floor` with no
 * allocation failure, no watchdog overrun, no crash and no quota exhaustion. The same marker was left by a page whose three quota
 * admissions all lapsed, and by a page dropped for ownership (the next legitimate run then asked at 2 after starting at 4).
 *
 * The engine, the plans and the guards here are the production ones over the store double; the faults are NAMED injections (the persistence
 * gate's answers, a transaction that fails, a response that is held). A genuine crash is modelled by what a crash is: an attempt whose
 * commit never returns, in a page that is then gone (`reload`), which is the one case the marker exists for and must keep detecting.
 */
const big = { deviceMemoryGiB: 8, hasStorageEstimate: true } as const;

const resource = (n: number, bytes: number) => ({
  id: uuid(20_000 + n),
  kind: "person",
  parent_id: null,
  label: "Person",
  value: { text: "x".repeat(bytes) },
  version: 1,
  can_edit: true,
  archived: false,
});
/** A page of 40 projections of 8,000 bytes (327,700 bytes, over the marker threshold) or one tiny one (under it). */
const page = (large = true, over: Partial<PageSpec> = {}): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: "after-page",
  batches: [
    {
      revision: 1,
      changes: Array.from({ length: large ? 40 : 1 }, (_, i) => ({
        kind: "upsert" as const,
        resource: resource(i, large ? 8_000 : 10),
      })),
    },
  ],
  ...over,
});

type World = Awaited<ReturnType<typeof engineWorld>>;
const limits = (w: World) =>
  w.requests.map((u) => Number(u.searchParams.get("limit")));
const attempt = (w: World) => w.sync().sizing.attempt;
const touched = (w: World, label: string) =>
  w.env.world.logs.filter((e) => (e as { label?: string }).label === label);

/** A world whose commits wait at the persistence gate, so a large page's attempt is IN FLIGHT: the marker written, nothing decided. */
async function inFlight(
  options: Parameters<typeof engineWorld>[0] = { signals: big },
) {
  const w = await engineWorld({ cursor: "cursor-0", ...options });
  w.gate.queue = true;
  w.script.push(w.json(page()));
  w.start();
  await w.settle();
  expect(w.gate.waiting, "the commit waits at the gate").toHaveLength(1);
  return w;
}
const answer = async (w: World, kind?: "held" | "stale" | "unavailable") => {
  const waiting = w.gate.waiting.shift();
  if (waiting === undefined) throw new Error("no commit is waiting");
  waiting.answer(kind);
  await w.settle();
};

describe("the fixture pages are the sizes they claim", () => {
  test("a large page is over the marker threshold and a small one is under it", async () => {
    const w = await engineWorld();
    const size = async (large: boolean) =>
      (await w.json(page(large)).arrayBuffer()).byteLength;
    expect(await size(true)).toBeGreaterThanOrEqual(DATA_CONFIG.markerMinBytes);
    expect(await size(false)).toBeLessThan(DATA_CONFIG.markerMinBytes);
  });
});

describe("controls: what the marker is for is untouched", () => {
  test("a healthy large page writes the marker before its commit, and the commit clears it in its own transaction: nothing retires it", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    w.engine.stop();
    expect(w.cache()).toHaveLength(40);
    expect(attempt(w)).toBeNull();
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    expect(touched(w, "data.recordSizingAttempt").length).toBeGreaterThan(0);
    expect(touched(w, "data.retireSizingAttempt")).toHaveLength(0);
  });

  test("a small page writes no marker and retires none, whatever happens to its commit", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.gate.mode = "unavailable";
    w.script.push(w.json(page(false)));
    w.start();
    await w.settle();
    w.engine.stop();
    expect(touched(w, "data.recordSizingAttempt")).toHaveLength(0);
    expect(touched(w, "data.retireSizingAttempt")).toHaveLength(0);
    expect(w.sync().sizing).toMatchObject({ floor_hits: 0, attempt: null });
  });

  test("a marker found at the start is a tab that did not survive: the ladder steps down before the next request", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.setSync({
      sizing: {
        class: "unconstrained",
        limit: 4,
        floor_hits: 0,
        attempt: { id: "abandoned", limit: 4, started_at: 1 },
      },
    });
    w.start();
    await w.settle();
    w.engine.stop();
    expect(limits(w)).toEqual([2]);
    expect(attempt(w)).toBeNull();
  });

  test("a genuine crash: a page whose commit never returned leaves its marker, and the next page steps down", async () => {
    const w = await inFlight();
    expect(attempt(w)).not.toBeNull();
    // The page is gone (no outcome was ever seen): a reload builds a new engine over the same database.
    w.reload();
    w.gate.queue = false;
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    w.engine.stop();
    expect(limits(w)).toEqual([4, 2]);
    expect(w.cache()).toHaveLength(40);
    expect(attempt(w)).toBeNull();
  });

  test("a genuine crash loop at the lowest rung still reaches the floor: three attempts that never returned", async () => {
    const w = await engineWorld({ cursor: "cursor-0" }); // no device-memory signal: the lowest rung
    w.gate.queue = true;
    for (let crash = 1; crash <= DATA_CONFIG.floorAfter; crash += 1) {
      w.script.push(w.json(page()));
      w.start();
      await w.settle();
      expect(w.gate.waiting, `attempt ${crash} is in flight`).toHaveLength(
        crash,
      );
      expect(attempt(w)).not.toBeNull();
      w.reload();
    }
    w.start();
    await w.settle();
    expect(w.sync().sizing).toMatchObject({
      limit: 1,
      floor_hits: DATA_CONFIG.floorAfter,
    });
    expect(w.state()).toEqual({ kind: "stopped", cause: "floor" });
    w.engine.stop();
  });

  test("a genuine crash is still detected after an earlier attempt ended normally and was retired", async () => {
    const w = await inFlight();
    await answer(w, "unavailable");
    expect(attempt(w)).toBeNull();
    w.engine.stop();
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(w.gate.waiting, "the second attempt is in flight").toHaveLength(1);
    expect(attempt(w)).not.toBeNull();
    w.reload();
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(limits(w).at(-1)).toBe(2);
    w.engine.stop();
  });
});

describe("R42: an attempt whose outcome the engine saw ends its marker, whatever the outcome", () => {
  /**
   * Every way the guarded commit can come back without applying the page. Each arranges what happens while the commit waits at the
   * persistence gate (after the marker was written and before anything is decided) and says how the gate then answers. The premise is
   * asserted first (the marker is there), and afterwards the record, not the verdict: no marker, no count, no step.
   */
  const exits: Array<{
    name: string;
    options?: Parameters<typeof engineWorld>[0];
    arrange?: (w: World) => void;
    answer?: "held" | "stale" | "unavailable";
  }> = [
    {
      name: "unverified (the persistence hold is unavailable)",
      answer: "unavailable",
    },
    {
      name: "identity_changed (the hold says the record names another identity)",
      answer: "stale",
    },
    {
      name: "identity_changed (the page's identity moved while the commit waited)",
      arrange: (w) => w.identity.move({ account: w.service.account, epoch: 2 }),
    },
    {
      name: "owner (another page owns the database)",
      options: { signals: big, ownerToken: "old" },
      arrange: (w) =>
        w.setSync({
          owner: { tab_id: "t", ownership_token: "new", heartbeat_at: 1 },
        }),
    },
    {
      name: "position (another page moved the cursor)",
      arrange: (w) => w.setSync({ cursor: "moved" }),
    },
    {
      name: "generation (a recovery generation began)",
      arrange: (w) => w.setSync({ recovery_generation: 7 }),
    },
    {
      name: "epoch_superseded (a later epoch is published)",
      arrange: (w) => w.setSync({ stamp: { epoch: 99 } }),
    },
    {
      name: "closing (a wipe is under way)",
      arrange: (w) =>
        w.setSync({
          draft_fence: { closing: true } as never,
        }),
    },
    {
      name: "not_ready (the cache stopped being valid while the response was in flight)",
      arrange: (w) => w.setSync({ cache_status: "invalid" }),
    },
    {
      name: "not_ready (the database left the delta phase)",
      arrange: (w) => w.setSync({ phase: "snapshot" as never }),
    },
  ];

  for (const exit of exits)
    test(`${exit.name}: no marker, no count, no step, and the next legitimate run asks at the same limit`, async () => {
      const w = await inFlight(exit.options ?? { signals: big });
      expect(attempt(w), "the attempt is in flight").not.toBeNull();
      exit.arrange?.(w);
      await answer(w, exit.answer);
      expect(w.cache(), "nothing was applied").toHaveLength(0);
      expect(attempt(w)).toBeNull();
      expect(w.sync().sizing).toMatchObject({
        limit: 4,
        floor_hits: 0,
        attempt: null,
      });
      // A legitimate run afterwards: the cause is undone, the commit is not held, and a large page is asked for at the limit it started at.
      w.engine.stop();
      w.gate.queue = false;
      w.gate.mode = "held";
      w.identity.move({ account: w.service.account, epoch: 1 });
      w.setSync({
        cursor: "cursor-0",
        recovery_generation: 0,
        stamp: null,
        draft_fence: null,
        cache_status: "valid",
        phase: "delta",
        owner:
          exit.options?.ownerToken === undefined
            ? null
            : { tab_id: "t", ownership_token: "old", heartbeat_at: 2 },
      });
      w.script.push(w.json(page()));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(new Set(limits(w))).toEqual(new Set([4]));
      expect(w.sync().sizing).toMatchObject({ floor_hits: 0, attempt: null });
    });

  test("three safe drops at the lowest rung are not the floor (the review's schedule: the persistence hold unavailable)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" }); // the lowest rung
    w.gate.mode = "unavailable";
    for (let n = 0; n < 8; n += 1) w.script.push(w.json(page()));
    w.start();
    await w.settle();
    for (let n = 0; n < 4; n += 1) {
      expect(w.sync().sizing, `after drop ${n + 1}`).toMatchObject({
        limit: 1,
        floor_hits: 0,
        attempt: null,
      });
      await w.advance(DATA_CONFIG.backoffMaxMs);
    }
    expect(w.requests.length).toBeGreaterThanOrEqual(4);
    expect(w.state()).not.toEqual({ kind: "stopped", cause: "floor" });
    expect(w.sync().cursor).toBe("cursor-0");
    // The persistence hold recovers: the next page asked for commits and the ladder is where it started.
    w.script.length = 0;
    w.script.push(w.json(page()));
    w.gate.mode = "held";
    await w.advance(DATA_CONFIG.backoffMaxMs);
    expect(w.cache()).toHaveLength(40);
    expect(w.sync().sizing).toMatchObject({ limit: 1, floor_hits: 0 });
    w.engine.stop();
  });

  describe("a hold that ends (the quota's lease lapses before the commit decides)", () => {
    const lapsing = (w: World, rounds: number, seen: Array<unknown> = []) => {
      let made = 0;
      Object.assign(w.quota, {
        check: async () => "ok",
        reserve: async (): Promise<QuotaReservation> => {
          made += 1;
          // What the marker is at the instant the page is admitted AGAIN: the lapsed round's marker must be gone by then.
          seen.push(attempt(w));
          const live = made > rounds;
          return { verdict: "ok", live: () => live, settle: () => {} };
        },
      });
      return () => made;
    };

    test("the marker of a lapsed round is retired BEFORE the page is admitted again, and the page then commits", async () => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      const seen: unknown[] = [];
      lapsing(w, 2, seen);
      w.script.push(w.json(page()));
      w.start();
      await w.settle();
      w.engine.stop();
      expect(seen).toHaveLength(3);
      expect(seen).toEqual([null, null, null]);
      expect(w.cache()).toHaveLength(40);
      expect(w.sync().sizing).toMatchObject({
        limit: 4,
        floor_hits: 0,
        attempt: null,
      });
    });

    test("all three admissions lapse, three times over, at the lowest rung: not the floor, and no marker is left", async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      const made = lapsing(w, 1_000);
      for (let n = 0; n < 8; n += 1) w.script.push(w.json(page()));
      w.start();
      await w.settle();
      for (let n = 0; n < 4; n += 1) {
        expect(w.sync().sizing).toMatchObject({
          limit: 1,
          floor_hits: 0,
          attempt: null,
        });
        await w.advance(DATA_CONFIG.backoffMaxMs);
      }
      expect(made()).toBeGreaterThanOrEqual(9);
      expect(w.state()).not.toEqual({ kind: "stopped", cause: "floor" });
      expect(w.cache()).toHaveLength(0);
      w.engine.stop();
    });

    test("a hold that ended after the marker was written and an admission that is then refused leaves no marker and moves no ladder", async () => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      let made = 0;
      Object.assign(w.quota, {
        check: async () => "ok",
        reserve: async (): Promise<QuotaReservation> => {
          made += 1;
          return {
            verdict: made === 1 ? "ok" : "refuse",
            live: () => false,
            settle: () => {},
          };
        },
      });
      w.script.push(w.json(page()));
      w.start();
      await w.settle();
      const state = w.state();
      w.engine.stop();
      expect(state).toEqual({ kind: "stopped", cause: "storage_full" });
      expect(attempt(w)).toBeNull();
      expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    });
  });

  describe("a commit that FAILS", () => {
    const inject = (w: World, mode: "error" | "quota" | "alloc") =>
      w.env.idb.inject({
        match: (tx) => tx.label === "data.commitPage",
        mode: { kind: "throw_on_write", n: 1, as: mode },
        times: 1,
      });

    for (const [as, expected] of [
      ["error", { limit: 2, floor_hits: 0 }],
      ["quota", { limit: 4, floor_hits: 0 }],
      ["alloc", { limit: 2, floor_hits: 0 }],
    ] as const)
      test(`${as}: its own outcome is recorded as before (limit ${expected.limit}), and no marker is left`, async () => {
        const w = await engineWorld({ signals: big, cursor: "cursor-0" });
        inject(w, as);
        w.script.push(w.json(page()));
        w.start();
        await w.settle();
        const state = w.state();
        w.engine.stop();
        if (as === "quota")
          expect(state).toEqual({ kind: "stopped", cause: "storage_full" });
        expect(attempt(w)).toBeNull();
        expect(w.sync().sizing).toMatchObject(expected);
      });

    test("a run that ended while the commit was stalled: the failure that comes back retires its attempt all the same", async () => {
      const w = await engineWorld({ signals: big, cursor: "cursor-0" });
      w.env.idb.inject({
        match: (tx) => tx.label === "data.commitPage",
        mode: "stall_commit",
        times: 1,
      });
      w.script.push(w.json(page()));
      w.start();
      await w.settle();
      expect(w.env.idb.hasStalledCommit(w.service.account)).toBe(false);
      const name = `atlas-${w.service.account}`;
      expect(w.env.idb.hasStalledCommit(name)).toBe(true);
      expect(attempt(w)).not.toBeNull();
      // The run is stopped while the commit is committing; then the commit fails without effect, as an engine's does.
      w.engine.stop();
      w.env.idb.failStalled(name);
      await w.settle();
      expect(attempt(w)).toBeNull();
      expect(w.cache()).toHaveLength(0);
    });
  });
});

describe("R42: stop, restart and an overtaken continuation", () => {
  test("a run stopped while its commit waited: the attempt ended too, so its marker is retired and the restarted run asks at the same limit", async () => {
    const w = await inFlight();
    w.engine.stop();
    w.start();
    // The new run's first step cannot begin until the old one has unwound.
    await w.settle();
    expect(limits(w)).toEqual([4]);
    await answer(w, "unavailable");
    expect(attempt(w)).toBeNull();
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    // The restarted run takes its turn when the old step unwinds: whatever it asks, it does not step down.
    w.gate.queue = false;
    w.gate.mode = "held";
    w.script.push(w.json(page()));
    await w.advance(DATA_CONFIG.backoffMaxMs);
    w.engine.stop();
    expect(new Set(limits(w))).toEqual(new Set([4]));
  });

  test("a lost ownership signal while the commit waited: the attempt's marker is retired when the commit drops", async () => {
    const w = await inFlight();
    w.ownership.abort();
    await answer(w, "unavailable");
    expect(attempt(w)).toBeNull();
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    w.engine.stop();
  });

  test("an overtaken attempt cannot erase a NEWER attempt's marker: its retirement is bound to its own id", async () => {
    const w = await inFlight();
    const first = attempt(w);
    expect(first).not.toBeNull();
    // Another page (a second engine over the same database) begins its own attempt while the first is still in flight.
    w.reload();
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(w.gate.waiting).toHaveLength(2);
    const second = attempt(w);
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
    // The first attempt ends now, with nothing landed: its late retirement finds a marker that is not its own.
    await answer(w, "unavailable");
    expect(attempt(w)).toEqual(second);
    // The second is still genuinely under way, and its own outcome retires it.
    await answer(w, "held");
    expect(w.cache()).toHaveLength(40);
    expect(attempt(w)).toBeNull();
    w.engine.stop();
  });

  test("an overtaken continuation's OUTCOME record does not erase a newer attempt's marker either (an unreadable answer arriving late)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    // The first run is still reading a body when it is overtaken; the body then turns out not to be a page.
    let release!: () => void;
    const late = new Response("{}");
    Object.defineProperty(late, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = () => resolve(new TextEncoder().encode("{}").buffer);
        }),
    });
    w.script.push(late);
    w.start();
    await w.settle();
    w.reload();
    w.gate.queue = true;
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    const newer = attempt(w);
    expect(newer, "the second run's attempt is in flight").not.toBeNull();
    release();
    await w.settle();
    expect(attempt(w)).toEqual(newer);
    await answer(w, "held");
    expect(attempt(w)).toBeNull();
    w.engine.stop();
  });
});

describe("R42: the marker's own bookkeeping fails", () => {
  const failRetire = (w: World) =>
    w.env.idb.inject({
      match: (tx) => tx.label === "data.retireSizingAttempt",
      mode: "error",
    });

  test("the retirement cannot be written: the page's own memory carries it to the next capture, which clears it without a count, and the engine is not stopped or slowed", async () => {
    const w = await engineWorld({ cursor: "cursor-0" }); // the lowest rung
    const off = failRetire(w);
    w.gate.mode = "unavailable";
    for (let n = 0; n < 8; n += 1) w.script.push(w.json(page()));
    w.start();
    await w.settle();
    for (let n = 0; n < 4; n += 1) {
      await w.advance(DATA_CONFIG.backoffMaxMs);
      expect(w.sync().sizing.floor_hits).toBe(0);
    }
    expect(w.state()).not.toEqual({ kind: "stopped", cause: "floor" });
    expect(w.state().kind).not.toBe("stopped");
    // Bounded: the schedule is the drop's own (a paced request each time), not a retry of the bookkeeping.
    expect(touched(w, "data.retireSizingAttempt").length).toBeLessThanOrEqual(
      2 * (w.requests.length + 1),
    );
    off();
    w.script.length = 0;
    w.script.push(w.json(page()));
    w.gate.mode = "held";
    await w.advance(DATA_CONFIG.backoffMaxMs);
    expect(w.cache()).toHaveLength(40);
    expect(w.sync().sizing).toMatchObject({ floor_hits: 0, attempt: null });
    w.engine.stop();
  });

  test("the retirement cannot be written and the page reloads before the next capture: the marker is read as it always was (the disclosed limitation)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    failRetire(w);
    w.gate.queue = true;
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    await answer(w, "unavailable");
    expect(
      attempt(w),
      "the retirement failed: the marker stands",
    ).not.toBeNull();
    w.engine.stop();
    w.reload();
    w.gate.queue = false;
    w.gate.mode = "held";
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    w.engine.stop();
    // Nothing remembered the attempt's end: one step down, and the ladder carries on. No stop, no floor.
    expect(limits(w)).toEqual([4, 2]);
    expect(w.sync().sizing).toMatchObject({ floor_hits: 0, attempt: null });
  });

  test("a marker whose write failed is harmless to retire (the write may have landed): the retirement is bound to the id and changes nothing when no marker carries it", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordSizingAttempt",
      mode: "error",
    });
    w.gate.mode = "unavailable";
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    w.engine.stop();
    expect(attempt(w)).toBeNull();
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    // The commit was refused all the same: the marker's absence never changed what the page did.
    expect(w.cache()).toHaveLength(0);
  });

  test("a marker written by a write that reported failure but landed is still retired (an ambiguous failure)", async () => {
    const w = await engineWorld({ signals: big, cursor: "cursor-0" });
    w.gate.queue = true;
    // The marker's write completes durably and then fails to report it: the engine does not know whether it landed.
    const real = w.service.store.run.bind(w.service.store);
    let landed = false;
    (w.service.store as { run: unknown }).run = async (
      plan: { name: string },
      input: unknown,
      options?: unknown,
    ) => {
      const result = await (
        real as (p: unknown, i: unknown, o?: unknown) => Promise<unknown>
      )(plan, input, options);
      if (plan.name === "data.recordSizingAttempt" && !landed) {
        landed = true;
        throw new Error("completion lost");
      }
      return result;
    };
    w.script.push(w.json(page()));
    w.start();
    await w.settle();
    expect(landed).toBe(true);
    expect(attempt(w)).not.toBeNull();
    await answer(w, "unavailable");
    expect(attempt(w)).toBeNull();
    expect(w.sync().sizing).toMatchObject({ limit: 4, floor_hits: 0 });
    w.engine.stop();
  });
});

describe("the plans of the marker, one by one", () => {
  const sizing = (over: object = {}) => ({
    class: "unconstrained" as const,
    limit: 4,
    floor_hits: 1,
    attempt: { id: "mine", limit: 4, started_at: 9 },
    ...over,
  });
  const retire = (w: World, id: string, incarnationId?: string) =>
    w.service.store.run(retireSizingAttempt, {
      incarnationId: incarnationId ?? w.service.incarnationId,
      id,
    });
  const capture = (w: World, endedAttempt?: string | null) =>
    w.service.store.run(captureRequest, {
      incarnationId: w.service.incarnationId,
      signals: big,
      ...(endedAttempt === undefined ? {} : { endedAttempt }),
    });

  test("retireSizingAttempt clears the marker of that attempt and changes nothing else of the row", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({ sizing: sizing() });
    const before = w.sync();
    await expect(retire(w, "mine")).resolves.toEqual({ retired: true });
    expect(w.sync()).toEqual({
      ...before,
      sizing: { ...before.sizing, attempt: null },
    });
  });

  test("it leaves another attempt's marker, an absent marker and a different incarnation alone", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({ sizing: sizing() });
    const before = w.sync();
    await expect(retire(w, "someone-else")).resolves.toEqual({
      retired: false,
    });
    expect(w.sync()).toEqual(before);
    await expect(retire(w, "mine", "another-incarnation")).rejects.toThrow();
    expect(w.sync()).toEqual(before);
    w.setSync({ sizing: sizing({ attempt: null }) });
    const none = w.sync();
    await expect(retire(w, "mine")).resolves.toEqual({ retired: false });
    expect(w.sync()).toEqual(none);
  });

  test("an absent marker is retired without a write (nothing changes, nothing is counted)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({ sizing: sizing({ attempt: null }) });
    const commits = () =>
      w.env.world.logs.filter(
        (e) =>
          e.type === "idb.commit" &&
          (e as { label?: string }).label === "data.retireSizingAttempt" &&
          (e as { wrote?: boolean }).wrote === true,
      ).length;
    await retire(w, "mine");
    expect(commits()).toBe(0);
  });

  test("captureRequest counts a marker as a crash unless it carries the id of an attempt this page saw end", async () => {
    for (const [offered, counted] of [
      [undefined, true],
      [null, true],
      ["someone-else", true],
      ["mine", false],
    ] as const) {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.setSync({ sizing: sizing({ floor_hits: 0 }) });
      const result = await capture(w, offered);
      expect(result.kind).toBe("captured");
      expect(
        (result as { steppedDown: boolean }).steppedDown,
        `offered ${String(offered)}`,
      ).toBe(counted);
      expect(w.sync().sizing).toMatchObject({
        attempt: null,
        limit: counted ? 2 : 4,
      });
    }
  });

  test("captureRequest clears a named marker even when the gate refuses the step (the floor), without a count", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.setSync({
      sizing: sizing({
        class: "unknown",
        limit: 1,
        floor_hits: DATA_CONFIG.floorAfter,
      }),
    });
    const result = await capture(w, "mine");
    expect(result).toMatchObject({ kind: "gated", reason: "floor" });
    expect(w.sync().sizing).toMatchObject({
      attempt: null,
      floor_hits: DATA_CONFIG.floorAfter,
      limit: 1,
    });
  });

  const outcomes: SizingOutcome[] = [
    { kind: "oversize" },
    { kind: "quota" },
    { kind: "allocation_failed" },
    { kind: "commit_failed", cause: "abort" },
    { kind: "commit_failed", cause: "error" },
    { kind: "watchdog", elapsedMs: 1 },
  ];
  for (const outcome of outcomes)
    test(`recordSizingOutcome(${outcome.kind}) decides the ladder and leaves the marker as it finds it`, async () => {
      const w = await engineWorld({ cursor: "cursor-0" });
      w.setSync({ sizing: sizing() });
      const result = await w.service.store.run(recordSizingOutcome, {
        incarnationId: w.service.incarnationId,
        outcome,
      });
      expect(result).toMatchObject({
        action: expect.any(String),
        sizing: { attempt: { id: "mine" } },
      });
      expect(w.sync().sizing.attempt).toEqual({
        id: "mine",
        limit: 4,
        started_at: 9,
      });
      const stepped = !["oversize", "quota"].includes(outcome.kind);
      expect(w.sync().sizing.limit).toBe(stepped ? 2 : 4);
    });

  test("recordSizingAttempt still writes the marker with the id it is given", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    await w.service.store.run(recordSizingAttempt, {
      incarnationId: w.service.incarnationId,
      id: "written",
      limit: 4,
      startedAt: 5,
    });
    expect(w.sync().sizing.attempt).toEqual({
      id: "written",
      limit: 4,
      started_at: 5,
    });
  });
});

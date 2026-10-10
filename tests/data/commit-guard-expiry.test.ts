// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DataRuntime } from "../../src/data/engine/account-service";
import { DATA_CONFIG } from "../../src/data/model/config";
import { accountDatabaseName } from "../../src/data/model/schema";
import { recordReadOutcome } from "../../src/data/plans/retry-state";
import type { AccountStore, Plan } from "../../src/data/store/port";
import { unrevokedHold } from "../../src/session";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import { DataTestWorld } from "../support/data/env";
import {
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * R2 (revisions 6 and 7): the persistence hold, when it RUNS OUT. The first revision released the shared `atlas-auth` lock at the bound and
 * left a transaction that was still queued (or applying) able to commit afterwards, on the strength of a verdict nobody was
 * vouching for any longer: another page could have settled a switch, a re-authentication or a sign-out in between, this page was
 * never told, and the old commit came back `applied`. The second gave the lock up again `persistenceDrainMs` after the revocation
 * even when a transaction that had already begun to commit was still unresolved, which reopened the same window for it.
 *
 * These schedules run the REAL session kernel over its deterministic platform (the page's `session.persistence`), the REAL
 * `DataRuntime` over the double of the data store, and another page that settles the transition under the exclusive lock, as every
 * real settlement does. Two worlds drive them: the session's (time, locks) and the store's (queues, completions).
 *
 * The rule under test: a commit is `applied` only if its transaction COMPLETED while the lock was still held, so no settlement can be
 * ordered ahead of it. At the bound the hold is revoked; a transaction that has not started, is reading or is applying is aborted
 * (nothing durable); one that is already committing cannot be, and the lock is kept until it ENDS, however long that takes. From
 * this page two things look identical: a commit that is still committing (its data is NOT durable yet, and will be), and a commit
 * that is durable whose completion has not been delivered. The double models both (`stall_commit` and a withheld `D0`) and every
 * schedule below runs against each; the only difference a test can see is whether the data is durable while the lock is held.
 * A stall is TRACED (`persistence.stalled`); it releases nothing, and a settlement requested meanwhile gives up and is not made.
 */
const HOLD = DEFAULT_CONFIG.persistenceHoldMs;
const STALL = DEFAULT_CONFIG.persistenceStallMs;
const CALLER = "expiry";

type Rig = Awaited<ReturnType<typeof rig>>;

async function rig(
  options: {
    withheld?: boolean;
    /** Wrap the store so that it IGNORES `RunOptions.signal`: only the decision's own check stands behind the revocation. */
    deafStore?: boolean;
  } = {},
) {
  const l = await signedInPage(await newWorld());
  const b = await openPage(l.fixture);
  // Page A (the committing page) is never told of what page B settles: every hint from B is held for ever.
  if (options.withheld !== false)
    l.fixture.world.setKnob("D2", "unbounded", (meta) => meta.from === b.id);
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("data");
  page.identity.account = l.account;
  const runtime = new DataRuntime({
    identity: l.page.session.identity,
    persistence: l.page.session.persistence,
    registry: page.registry,
    open: async (a, o) => {
      const outcome = await page.open(a, o);
      if (outcome.kind !== "opened" || options.deafStore !== true)
        return outcome;
      const inner = outcome.store;
      const deaf: AccountStore = {
        account: inner.account,
        incarnationId: inner.incarnationId,
        run: (plan, input) => inner.run(plan, input),
        watch: (plan, input) => inner.watch(plan, input),
        close: () => inner.close(),
      };
      return { ...outcome, store: deaf };
    },
  });
  const opened = await runtime.open(l.account, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  await env.settle();
  const name = accountDatabaseName(l.account);
  const written = (): boolean => {
    const sync = env.idb.snapshot(name)?.sync_state?.[0] as
      | { read_retry_states?: Record<string, unknown> }
      | undefined;
    return sync?.read_retry_states?.[CALLER] !== undefined;
  };
  return { l, b, env, page, runtime, svc: opened.service, name, written };
}

const input = (r: Rig) => ({
  captured: r.svc.capture(r.l.epoch),
  caller: CALLER,
  outcome: { kind: "failure" as const },
  now: 1,
});

const blocker: Plan<null, null, null> = {
  name: "review.blocker",
  scope: ["sync_state"],
  mode: "readonly",
  durability: "default",
  read: async () => null,
  decide: () => ({ writes: [], result: null }),
};

/** A transaction that never ends and ahead of which everything else on `sync_state` queues. */
async function block(r: Rig): Promise<void> {
  r.env.idb.inject({
    match: (tx) => tx.label === blocker.name,
    mode: "pending_blocking",
    times: 1,
  });
  void r.svc.store.run(blocker, null).catch(() => undefined);
  await r.env.settle();
}

/** The writer, with an `apply` that waits on a gate AFTER its decision's writes were issued (so there is something to roll back). */
function gatedWriter(gate: Promise<void>): typeof recordReadOutcome {
  return {
    ...recordReadOutcome,
    apply: async (_sink, decision) => {
      await gate;
      return decision.result;
    },
  } as typeof recordReadOutcome;
}

const heldBy = (r: Rig) => r.l.fixture.locks.heldNames(r.l.page.id);

type Transition = "switch" | "reauth" | "signout";
const TRANSITIONS: readonly Transition[] = ["switch", "reauth", "signout"];

/** Another page settles the transition (under the exclusive lock, as every real settlement is). */
function transition(r: Rig, kind: Transition): Promise<unknown> {
  const f = r.l.fixture;
  switch (kind) {
    case "switch":
      return f.signIn(r.b, "sam", "pw2");
    case "reauth":
      return f.signIn(r.b, "kieran", "pw");
    case "signout":
      return f
        .runWith(
          r.b.session.operations.logout({
            unsynced: { count: 0, items: [], digest: "0" },
          }),
        )
        .then(() => f.settle());
  }
}

/** The durable session record no longer says (A, epoch). */
const moved = (r: Rig): boolean => {
  const settled = stateOf(r.l.fixture).settled;
  return (
    settled === null ||
    settled.account_id !== r.l.account ||
    settled.epoch !== r.l.epoch
  );
};

const traces = (r: Rig, name: string) =>
  r.l.fixture.world.logs.filter((e) => e.type === `trace.persistence.${name}`);

async function advance(r: Rig, ms: number): Promise<void> {
  await r.l.fixture.world.advance(ms);
  await r.env.settle();
}

describe("the premise: the margin between the hold and the apply watchdog", () => {
  test("the hold's bound is at least 10 s above the data layer's apply watchdog, so a slow apply meets the WATCHDOG (a step-down), never the revocation (an endless retry)", () => {
    expect(HOLD).toBeGreaterThanOrEqual(
      DATA_CONFIG.syncApplyWatchdogMs + 10_000,
    );
  });
});

describe("the control: a hold that does NOT expire (the commit is ordered before the settlement)", () => {
  test.each(TRANSITIONS)(
    "queued behind a blocker that ends in time, then %s: the commit persists first, the settlement waits",
    async (kind) => {
      const r = await rig();
      await block(r);
      const commit = r.svc.commit(recordReadOutcome, input(r));
      await r.l.fixture.world.runUntilIdle();
      await r.env.settle();
      expect(heldBy(r)).toContain("atlas-auth");
      const order: string[] = [];
      void commit.then(() => order.push("commit"));
      const settling = transition(r, kind).then(() => order.push("settled"));
      await r.l.fixture.world.runUntilIdle();
      expect(moved(r)).toBe(false);
      r.env.idb.releaseStuck(r.name);
      await r.env.settle();
      await settling;
      expect(await commit).toMatchObject({ kind: "applied" });
      expect(order).toEqual(["commit", "settled"]);
      expect(r.written()).toBe(true);
      expect(moved(r)).toBe(true);
      expect(traces(r, "timed_out")).toEqual([]);
      expect(r.l.fixture.store.violations).toEqual([]);
      r.runtime.dispose();
    },
  );
});

describe("the hold runs out while the transaction is QUEUED or APPLYING: it is aborted, nothing is durable, and the settlement is let in at once", () => {
  const positions = ["queued", "applying"] as const;
  const when = ["settlement requested before the bound", "after it"] as const;
  const notices = [true, false] as const;
  for (const position of positions)
    for (const kind of TRANSITIONS)
      for (const timing of when)
        for (const withheld of notices)
          test(`${position}, ${kind}, ${timing}, notices ${withheld ? "withheld" : "delivered"}`, async () => {
            const r = await rig({ withheld });
            let open!: () => void;
            const gate = new Promise<void>((resolve) => {
              open = resolve;
            });
            let commit: ReturnType<typeof r.svc.commit>;
            if (position === "queued") {
              await block(r);
              commit = r.svc.commit(recordReadOutcome, input(r));
            } else {
              commit = r.svc.commit(gatedWriter(gate), input(r));
            }
            // What the commit settled as, recorded so that a commit that NEVER settles (the revocation not reaching the store) fails an
            // assertion below, instead of leaving this test to wait for it until its time-out (revision 12).
            let landed: unknown = "pending";
            void commit.then((outcome) => {
              landed = outcome;
            });
            await r.l.fixture.world.runUntilIdle();
            await r.env.settle();
            expect(heldBy(r)).toContain("atlas-auth");

            let settling: Promise<unknown> | null = null;
            if (timing === "after it") {
              await advance(r, HOLD + 1_000);
              settling = transition(r, kind);
            } else {
              // Inside the session's own wait for the lock (20 s), so the request is still queued when the bound is reached.
              await advance(r, HOLD - 8_000);
              settling = transition(r, kind);
              await r.l.fixture.world.runUntilIdle();
              expect(moved(r)).toBe(false);
              await advance(r, 9_000);
            }
            await r.env.settle();
            // The reactions of the settled promises run before the commit's outcome is read.
            await new Promise((done) => setTimeout(done, 0));
            // Revoked at the bound (traced), the transaction aborted: the commit is NOT applied.
            expect(traces(r, "timed_out")).toHaveLength(1);
            expect(landed).toEqual({ kind: "dropped", reason: "unverified" });
            expect(await commit).toEqual({
              kind: "dropped",
              reason: "unverified",
            });
            await settling;
            // The durable session moved; this page's own copy may not have (notices withheld): the old commit must not have
            // landed whatever the page believes.
            expect(moved(r)).toBe(true);
            expect(r.written()).toBe(false);
            if (position === "queued") {
              r.env.idb.releaseStuck(r.name);
              await r.env.settle();
              expect(r.written()).toBe(false);
            } else {
              open();
              await r.env.settle();
              expect(r.written()).toBe(false);
            }
            // The lock was given up because the transaction ENDED (it was aborted): there was no stall to report.
            expect(traces(r, "stalled")).toEqual([]);
            expect(heldBy(r)).not.toContain("atlas-auth");
            expect(r.l.fixture.store.violations).toEqual([]);
            r.runtime.dispose();
          });

  test("the reviewer's schedule, unchanged: queued behind a blocking sync_state transaction, the other page's notices withheld, 31 s, settle B, release the blocker", async () => {
    const r = await rig();
    await block(r);
    const commit = r.svc.commit(recordReadOutcome, input(r));
    await r.l.fixture.world.runUntilIdle();
    await r.env.settle();
    expect(heldBy(r)).toContain("atlas-auth");
    await r.l.fixture.world.advance(31_000);
    expect(traces(r, "timed_out")).toHaveLength(1);
    expect((await r.l.fixture.signIn(r.b, "sam", "pw2")).kind).toBe("settled");
    expect(stateOf(r.l.fixture).settled?.account_id).not.toBe(r.l.account);
    expect(r.l.page.session.identity.get()?.account_id).toBe(r.l.account);
    r.env.idb.releaseStuck(r.name);
    await r.env.settle();
    expect((await commit).kind).toBe("dropped");
    expect(r.written()).toBe(false);
    r.runtime.dispose();
  });
});

/**
 * What is outstanding when the hold runs out and the transaction cannot be aborted:
 *  - `unfinished`: the engine is still COMMITTING: the transaction's data is NOT durable yet (it will be, or the commit fails);
 *  - `delayed`: the data IS durable and only the completion has not been delivered to this page.
 * The page's `run` promise is unresolved in both, and that is all it can know.
 */
type Outstanding = "unfinished" | "delayed";
const OUTSTANDING: readonly Outstanding[] = ["unfinished", "delayed"];

function arm(r: Rig, kind: Outstanding): void {
  if (kind === "unfinished")
    r.env.idb.inject({
      match: (tx) => tx.label === recordReadOutcome.name,
      mode: "stall_commit",
      times: 1,
    });
  else
    r.env.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.label === recordReadOutcome.name,
    );
}

/** The engine ends the outstanding commit (the data becomes durable now, or the completion is delivered now). */
function finish(r: Rig, kind: Outstanding): void {
  if (kind === "unfinished") {
    if (!r.env.idb.completeStalled(r.name)) throw new Error("nothing stalled");
  } else r.env.world.release("D0");
}

/**
 * Starts the commit and runs until it is outstanding. The promise is returned INSIDE an object: an async function that returned the
 * promise itself would be awaited until the commit settles, which is exactly what the schedules keep from happening.
 */
async function outstandingCommit(r: Rig, kind: Outstanding) {
  arm(r, kind);
  const commit = r.svc.commit(recordReadOutcome, input(r));
  await r.l.fixture.world.runUntilIdle();
  await r.env.settle();
  // The two differ in one thing only: whether the data is durable while the page waits.
  expect(r.written()).toBe(kind === "delayed");
  expect(r.env.idb.hasStalledCommit(r.name)).toBe(kind === "unfinished");
  expect(heldBy(r)).toContain("atlas-auth");
  return { commit };
}

/** A settlement attempt on page B while the lock is held: it gives up at its own bound, and nothing is settled. */
async function attemptWhileHeld(r: Rig, kind: Transition): Promise<string> {
  const f = r.l.fixture;
  const call =
    kind === "signout"
      ? r.b.session.operations.logout({
          unsynced: { count: 0, items: [], digest: "0" },
        })
      : r.b.session.attempts.begin("password");
  await f.world.advance(21_000);
  await f.world.runUntilIdle();
  // `begin` answers `{ kind: "lock_timeout" }`; a logout answers `{ kind: "refused", reason: "closing_write_gave_up" }`.
  const outcome = (await call) as { kind: string; reason?: string };
  return outcome.reason ?? outcome.kind;
}

describe("the hold runs out while the transaction is already COMMITTING: it cannot be aborted, so the lock stays held until the commit ENDS", () => {
  for (const kind of OUTSTANDING)
    for (const transitionKind of TRANSITIONS)
      for (const withheld of [true, false])
        test(`${kind}, ${transitionKind}, notices ${withheld ? "withheld" : "delivered"}: the settlement requested inside the bound waits; the commit is applied FIRST, then the settlement`, async () => {
          const r = await rig({ withheld });
          const { commit } = await outstandingCommit(r, kind);
          const order: string[] = [];
          void commit.then(() => order.push("commit"));
          await advance(r, HOLD - 8_000);
          const settling = transition(r, transitionKind).then(() =>
            order.push("settled"),
          );
          await r.l.fixture.world.runUntilIdle();
          await advance(r, 9_000);
          expect(traces(r, "timed_out")).toHaveLength(1);
          // Revoked, but there is nothing to abort: the lock is STILL held and the settlement has not been made.
          expect(heldBy(r)).toContain("atlas-auth");
          expect(moved(r)).toBe(false);
          expect(traces(r, "released")).toEqual([]);
          // The engine ends the commit. From this instant the data is durable, and the settlement has still not been made: the
          // write is ordered BEFORE it.
          finish(r, kind);
          expect(r.written()).toBe(true);
          expect(moved(r)).toBe(false);
          await r.env.settle();
          await r.l.fixture.world.runUntilIdle();
          await settling;
          expect(await commit).toMatchObject({ kind: "applied" });
          expect(order).toEqual(["commit", "settled"]);
          expect(moved(r)).toBe(true);
          expect(r.written()).toBe(true);
          expect(r.l.fixture.store.violations).toEqual([]);
          r.runtime.dispose();
        });

  for (const kind of OUTSTANDING)
    for (const transitionKind of TRANSITIONS)
      for (const withheld of [true, false])
        test(`${kind}, ${transitionKind}, notices ${withheld ? "withheld" : "delivered"}, a LONG stall: past the bound AND the stall report the lock is still held, the stall is traced once, the settlement gives up and is not made, and it is made only after the commit ends`, async () => {
          const r = await rig({ withheld });
          const { commit } = await outstandingCommit(r, kind);
          // Longer than the bound plus the stall report plus anything a settlement waits: the interval in which the previous
          // revision released the lock and let a settlement in ahead of the commit.
          await advance(r, HOLD - 1_000);
          expect(traces(r, "stalled")).toEqual([]);
          await advance(r, 2_000 + STALL);
          expect(traces(r, "timed_out")).toHaveLength(1);
          expect(traces(r, "stalled")).toHaveLength(1);
          expect(heldBy(r)).toContain("atlas-auth");
          // A settlement now gives up at its own bound (`lockWaitMs`); it is not made, and the account's record is untouched.
          const gaveUp = await attemptWhileHeld(r, transitionKind);
          // A sign-out is refused as its closing write gave up; a sign-in or a switch cannot begin (`lock_timeout`).
          expect(gaveUp).toBe(
            transitionKind === "signout"
              ? "closing_write_gave_up"
              : "lock_timeout",
          );
          expect(moved(r)).toBe(false);
          // Much longer still: nothing is given up, and the stall is not reported again.
          await advance(r, 600_000);
          expect(heldBy(r)).toContain("atlas-auth");
          expect(traces(r, "stalled")).toHaveLength(1);
          expect(traces(r, "released")).toEqual([]);
          expect(moved(r)).toBe(false);
          // An unfinished commit is still not durable: nothing of it landed, before or after any settlement.
          expect(r.written()).toBe(kind === "delayed");
          // The commit ends: the data is durable and the settlement has not been made.
          finish(r, kind);
          expect(r.written()).toBe(true);
          expect(moved(r)).toBe(false);
          await r.env.settle();
          await r.l.fixture.world.runUntilIdle();
          expect(await commit).toMatchObject({ kind: "applied" });
          expect(heldBy(r)).not.toContain("atlas-auth");
          // Only now can a settlement be made, and it is ordered after the commit.
          expect(moved(r)).toBe(false);
          await transition(r, transitionKind);
          expect(moved(r)).toBe(true);
          expect(r.written()).toBe(true);
          expect(r.l.fixture.store.violations).toEqual([]);
          r.runtime.dispose();
        });

  test("an unfinished commit that the engine then FAILS (a quota or an I/O error at commit): nothing is durable, the work has settled, the lock goes, and only then is a settlement made", async () => {
    const r = await rig();
    const { commit } = await outstandingCommit(r, "unfinished");
    await advance(r, HOLD + STALL + 1_000);
    expect(heldBy(r)).toContain("atlas-auth");
    expect(await attemptWhileHeld(r, "switch")).toBe("lock_timeout");
    expect(moved(r)).toBe(false);
    expect(r.env.idb.failStalled(r.name, "quota")).toBe(true);
    await r.env.settle();
    await r.l.fixture.world.runUntilIdle();
    const result = await commit;
    // Not applied: the transaction did not commit. It is the store's failure (a quota), not a revocation.
    expect(result).toMatchObject({ kind: "failed" });
    expect(r.written()).toBe(false);
    expect(heldBy(r)).not.toContain("atlas-auth");
    expect(moved(r)).toBe(false);
    expect((await r.l.fixture.signIn(r.b, "sam", "pw2")).kind).toBe("settled");
    expect(r.written()).toBe(false);
    r.runtime.dispose();
  });

  test("a page that is CLOSED while its commit is outstanding frees the lock with it (a Web Lock does not outlive its page): the browser is never blocked by a page that is gone", async () => {
    const r = await rig();
    await outstandingCommit(r, "unfinished");
    await advance(r, HOLD + STALL + 1_000);
    expect(heldBy(r)).toContain("atlas-auth");
    expect(await attemptWhileHeld(r, "switch")).toBe("lock_timeout");
    r.l.fixture.locks.destroyPage(r.l.page.id);
    expect((await r.l.fixture.signIn(r.b, "sam", "pw2")).kind).toBe("settled");
    expect(r.l.fixture.store.violations).toEqual([]);
  });

  test("the control for the schedules above: a commit that completes INSIDE the bound is ordered before the settlement and nothing is traced", async () => {
    for (const kind of OUTSTANDING) {
      const r = await rig();
      const { commit } = await outstandingCommit(r, kind);
      finish(r, kind);
      await r.env.settle();
      expect(await commit).toMatchObject({ kind: "applied" });
      expect(traces(r, "timed_out")).toEqual([]);
      expect(traces(r, "stalled")).toEqual([]);
      expect(heldBy(r)).not.toContain("atlas-auth");
      r.runtime.dispose();
    }
  });
});

describe("two layers stand behind the revocation", () => {
  test("a store that IGNORES the signal still cannot persist: the lock is kept while the queued transaction is unresolved, and when the engine finally starts it its decision sees the revoked hold and writes nothing", async () => {
    const r = await rig({ deafStore: true });
    await block(r);
    const commit = r.svc.commit(recordReadOutcome, input(r));
    await r.l.fixture.world.runUntilIdle();
    await r.env.settle();
    // The signal reaches nobody that acts on it: nothing aborts the queued transaction, so the lock is kept for as long as it is
    // unresolved: past the bound, past the stall report, and a settlement gives up rather than being ordered ahead of it.
    await advance(r, HOLD + 1_000);
    expect(heldBy(r)).toContain("atlas-auth");
    await advance(r, STALL);
    expect(traces(r, "stalled")).toHaveLength(1);
    expect(heldBy(r)).toContain("atlas-auth");
    expect(await attemptWhileHeld(r, "switch")).toBe("lock_timeout");
    expect(moved(r)).toBe(false);
    // The engine finally starts the queued transaction: its decision sees the revoked hold and writes nothing, the work settles,
    // the lock goes, and the settlement is then made.
    r.env.idb.releaseStuck(r.name);
    await r.env.settle();
    await r.l.fixture.world.runUntilIdle();
    expect(await commit).toEqual({ kind: "dropped", reason: "unverified" });
    expect(r.written()).toBe(false);
    expect(heldBy(r)).not.toContain("atlas-auth");
    expect((await r.l.fixture.signIn(r.b, "sam", "pw2")).kind).toBe("settled");
    expect(r.written()).toBe(false);
    r.runtime.dispose();
  });

  test("a hold that is already invalid when the service is about to start the transaction starts nothing", async () => {
    const r = await rig();
    let started = 0;
    const runtime = new DataRuntime({
      identity: r.l.page.session.identity,
      persistence: {
        hold: async () => ({ ...unrevokedHold(), valid: () => false }),
      },
      registry: r.page.registry,
      open: async (a, o) => {
        const outcome = await r.page.open(a, o);
        if (outcome.kind !== "opened") return outcome;
        const inner = outcome.store;
        const counting: AccountStore = {
          account: inner.account,
          incarnationId: inner.incarnationId,
          run: (plan, input, options) => {
            // The epoch publication that opening a service makes is not the commit under test.
            if (plan.name === recordReadOutcome.name) started += 1;
            return inner.run(plan, input, options);
          },
          watch: (plan, input) => inner.watch(plan, input),
          close: () => inner.close(),
        };
        return { ...outcome, store: counting };
      },
    });
    const opened = await runtime.open(r.l.account);
    if (opened.kind !== "opened") throw new Error("setup");
    const commit = opened.service.commit(recordReadOutcome, {
      captured: opened.service.capture(r.l.epoch),
      caller: CALLER,
      outcome: { kind: "failure" as const },
      now: 1,
    });
    await r.l.fixture.world.runUntilIdle();
    await r.env.settle();
    const result = await commit;
    expect(result).toEqual({ kind: "dropped", reason: "unverified" });
    expect(started).toBe(0);
    expect(r.written()).toBe(false);
    runtime.dispose();
    r.runtime.dispose();
  });
});

describe("a store failure that is not a revocation is still a failure", () => {
  test("an aborted transaction under a VALID hold is reported as the store's failure, not as `unverified`", async () => {
    const r = await rig();
    r.env.idb.inject({
      match: (tx) => tx.label === recordReadOutcome.name,
      mode: "abort",
      times: 1,
    });
    const commit = r.svc.commit(recordReadOutcome, input(r));
    await r.l.fixture.world.runUntilIdle();
    await r.env.settle();
    const result = await commit;
    expect(result.kind).toBe("failed");
    expect(heldBy(r)).not.toContain("atlas-auth");
    r.runtime.dispose();
  });
});

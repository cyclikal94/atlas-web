// @vitest-environment node
import { describe, expect, test } from "vitest";
import { accountDatabaseName } from "../../src/data/model/schema";
import { openAccountData } from "../../src/data/store/open";
import type { Latch } from "../../src/data/store/registry";
import { LOCKS } from "../../src/session/constants";
import {
  A,
  B,
  type Gate,
  gate,
  type Holds,
  type PendingWorld,
  setup,
} from "../support/data/pending-open";

/**
 * R36 and R37 (revision 21): THE LIFETIME OF A DATABASE OPEN.
 *
 * R36. Creating a database needs the account's identity and no pending logout or retirement at the CREATING BOUNDARY, not only when the
 * call is made. The review held the listing made under the wipe's lock, changed one fact and let it go: the open created the database
 * and answered `opened` for an account the page had left. The predicate is now evaluated again after every wait (the lock, the listing
 * under it) in the step that starts the creating open, and once more inside the creating upgrade itself (`permit`), so no fact that
 * changed while the request was queued in the engine can create a database either. A refusal creates nothing and deletes nothing: a
 * database made without authority would be the wipe's to remove, and the fix must never need that.
 *
 * R37. An open that a CLOSURE ended (a wipe, another tab's deletion or upgrade, the identity leaving: `registry.closeAll`, or a latch
 * to anything but `open`) must neither lift the latch nor publish a service, and must let go of exactly the handles it opened. Whether
 * a closure ended an open is a question about ITS LIFETIME, which the registry's `generation(account)` answers: the open reads it when it
 * is asked, and a closure since then ends it. The latch's current value cannot tell an open that a closure ended from a deliberately
 * authorised NEW open (which begins while the account is latched and lifts that latch when it finishes).
 *
 * Both layers hold the invariant on their own: `openAccountData` (over the double of the opener) and the runtime (over a bare opener).
 * FIXTURE evidence: the double of IndexedDB. The real Dexie opener, with real connections, is in the real-engine spec
 * `fixture.data-open-closure.spec.ts`.
 */
const DB = accountDatabaseName(A);
const NOTHING = {
  connections: 0,
  service: false,
  published: 0,
} as const;

/** The three waits of a creation and where each is held: behind the wipe's lock, in the listing made under it, in the creating upgrade. */
type CreationPhase = {
  name: string;
  /** Holds for the world; `lock` waits behind another page's wipe lock instead. */
  holds?: (g: Gate) => Holds;
  lock?: true;
  /** Native opens begun when the phase is over and the creation was refused. */
  opens: number;
  /** The phase is the creating upgrade itself. */
  upgrade?: true;
};
const CREATION_PHASES: CreationPhase[] = [
  { name: "the creation waits behind the wipe's lock", lock: true, opens: 0 },
  {
    name: "the listing made under the lock is pending",
    holds: (g) => ({ listing: { 2: g } }),
    opens: 0,
  },
  {
    // The wrapper holds the call BEFORE the double creates the database: everything the sync check read has been read, and what is asked
    // inside the creating upgrade is the only thing left.
    name: "the creating upgrade is pending",
    holds: (g) => ({ before: { 1: g } }),
    opens: 1,
    // Only an opener that asks `permit` inside the upgrade can refuse here: the step before it has passed.
    upgrade: true,
  },
];

/** What a phase holds, and the means to release it. */
async function hold(f: PendingWorld, phase: CreationPhase, g: Gate) {
  if (phase.lock === true) {
    const wipe = f.world.page("W");
    const lock = await f.world.run(wipe.locks.acquire(LOCKS.wipe(A)));
    if (lock === null) throw new Error("the wipe lock was not granted");
    return {
      reached: async () => f.world.settle(),
      release: () => lock.release(),
    };
  }
  return { reached: () => g.reached, release: () => g.release() };
}

const CHANGES: Array<{
  name: string;
  apply(f: PendingWorld): void;
  refusal: { kind: "refused"; reason: string };
  latch: Latch;
}> = [
  {
    name: "the page's identity moves to another account",
    apply: (f) => {
      f.page.identity.account = B;
      f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
    },
    refusal: { kind: "refused", reason: "identity" },
    latch: "open",
  },
  {
    name: "the page signs out",
    apply: (f) => {
      f.page.identity.account = null;
      f.identity.set(null);
    },
    refusal: { kind: "refused", reason: "identity" },
    latch: "open",
  },
  {
    name: "a logout or retirement becomes pending",
    apply: (f) => {
      f.page.pending.add(A);
    },
    refusal: { kind: "refused", reason: "operation_pending" },
    latch: "open",
  },
  {
    name: "the account is closed on the page (a wipe latched it)",
    apply: (f) => {
      f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    },
    refusal: { kind: "refused", reason: "closed" },
    latch: "closed_for_deletion",
  },
];

describe("R36: the may-create predicate holds at the creating boundary", () => {
  // Two layers hold the predicate and each is shown on its own: `openAccountData` reads it in the step that starts the creating open (an
  // opener that ignores `permit`: only this layer stands between a changed fact and a creation), and the opener reads it inside the
  // creating upgrade (`permit`; the only layer that can see a fact that changed while the request was queued).
  for (const honour of [true, false])
    for (const phase of CREATION_PHASES) {
      if (!honour && phase.upgrade === true) continue;
      const opener = honour
        ? "an opener that honours `permit`"
        : "an opener that ignores `permit`";
      runCreation(phase, opener, honour);
    }

  function runCreation(
    phase: CreationPhase,
    opener: string,
    honour: boolean,
  ): void {
    for (const change of CHANGES)
      test(`${phase.name} (${opener}), then ${change.name}: the creation is refused, nothing is created and nothing is held`, async () => {
        const g = gate();
        const f = await setup({
          seeded: false,
          honourPermit: honour,
          ...(phase.holds ? { holds: phase.holds(g) } : {}),
        });
        const wait = await hold(f, phase, g);
        const rt = f.runtime();
        const pending = rt.open(A, { create: true });
        await wait.reached();
        change.apply(f);
        wait.release();
        expect(await pending).toEqual(change.refusal);
        await f.world.settle();
        // The creating upgrade ran no `populate`: the database does not exist, and no connection was ever kept.
        expect(f.world.idb.has(DB)).toBe(false);
        expect(f.held(rt)).toEqual({ ...NOTHING, latch: change.latch });
        expect(f.page.registry.openCount(A)).toBe(0);
        // A refusal before the native open began is a native open that never began; one inside the upgrade is the call that was refused.
        expect(f.calls.opens).toBe(phase.opens);
        rt.dispose();
      });

    test(`${phase.name} (${opener}), then the runtime is disposed: the creation is refused \`abandoned\` and nothing is created`, async () => {
      const g = gate();
      const f = await setup({
        seeded: false,
        honourPermit: honour,
        ...(phase.holds ? { holds: phase.holds(g) } : {}),
      });
      const wait = await hold(f, phase, g);
      const rt = f.runtime();
      const pending = rt.open(A, { create: true });
      await wait.reached();
      rt.dispose();
      wait.release();
      expect(await pending).toEqual({ kind: "refused", reason: "abandoned" });
      await f.world.settle();
      expect(f.world.idb.has(DB)).toBe(false);
      expect(f.held(rt)).toEqual({ ...NOTHING, latch: "open" });
    });

    test(`control: ${phase.name} (${opener}) and nothing changes: the database is created, opened and served`, async () => {
      const g = gate();
      const f = await setup({
        seeded: false,
        honourPermit: honour,
        ...(phase.holds ? { holds: phase.holds(g) } : {}),
      });
      const wait = await hold(f, phase, g);
      const rt = f.runtime();
      const pending = rt.open(A, { create: true });
      await wait.reached();
      wait.release();
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "opened", created: true });
      expect(f.world.idb.has(DB)).toBe(true);
      expect(f.held(rt)).toMatchObject({ connections: 2, service: true });
      rt.dispose();
    });
  }

  test("control: a logout or retirement already pending when the call is made is refused before any lock or listing beyond the first", async () => {
    const f = await setup({ seeded: false });
    f.page.pending.add(A);
    const rt = f.runtime();
    expect(await rt.open(A, { create: true })).toEqual({
      kind: "refused",
      reason: "operation_pending",
    });
    expect(f.calls).toEqual({ listings: 1, opens: 0 });
    expect(f.world.idb.has(DB)).toBe(false);
    rt.dispose();
  });

  test("control: an identity that is not the account's when the call is made is refused before any listing", async () => {
    const f = await setup({ seeded: false });
    f.page.identity.account = B;
    const rt = f.runtime();
    expect(await rt.open(A, { create: true })).toEqual({
      kind: "refused",
      reason: "identity",
    });
    expect(f.calls).toEqual({ listings: 0, opens: 0 });
    rt.dispose();
  });

  test("a runtime disposed while the creating upgrade is pending, with a healthy replacement runtime creating the same account behind it: the old creation makes nothing and the replacement's database and connections stand", async () => {
    const g = gate();
    const f = await setup({ seeded: false, holds: { listing: { 2: g } } });
    const old = f.runtime();
    const pending = old.open(A, { create: true });
    await g.reached;
    old.dispose();
    // The replacement waits for the wipe lock the old creation still holds, and takes it the moment the old one lets it go.
    const replacement = f.runtime();
    const next = replacement.open(A, { create: true });
    g.release();
    expect(await pending).toEqual({ kind: "refused", reason: "abandoned" });
    expect(await next).toMatchObject({ kind: "opened", created: true });
    await f.world.settle();
    expect(f.world.idb.has(DB)).toBe(true);
    expect(f.page.registry.openCount(A)).toBe(2);
    expect(f.page.registry.latch(A)).toBe("open");
    expect(replacement.serviceFor(A)?.live).toBe(true);
    replacement.dispose();
  });

  test("a creation that has finished in the engine is not taken back when a fact then changes: the database stays (a deletion is the wipe's decision) and the runtime refuses the identity and closes the handles", async () => {
    const g = gate();
    const f = await setup({ seeded: false, holds: { landed: { 1: g } } });
    const rt = f.runtime();
    const pending = rt.open(A, { create: true });
    await g.reached;
    f.page.identity.account = B;
    f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
    g.release();
    expect(await pending).toEqual({ kind: "refused", reason: "identity" });
    await f.world.settle();
    expect(f.world.idb.has(DB)).toBe(true);
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.held(rt)).toMatchObject({ service: false, published: 0 });
    rt.dispose();
  });
});

/** The phases of a pending open of an EXISTING database. */
const OPEN_PHASES = [
  {
    name: "the discovery of the databases is pending",
    holds: (g: Gate): Holds => ({ listing: { 1: g } }),
    // The closure is seen before anything is started.
    opens: 0,
  },
  {
    name: "the native open has not started",
    holds: (g: Gate): Holds => ({ before: { 1: g } }),
    opens: 1,
  },
  {
    name: "the native open has finished and its result has not reached the runtime",
    holds: (g: Gate): Holds => ({ landed: { 1: g } }),
    opens: 1,
  },
] as const;

const CLOSURES: Array<{
  name: string;
  close(f: PendingWorld): void;
  latch: Latch;
}> = [
  {
    name: "closeAll for a deletion",
    close: (f) => f.page.registry.closeAll(A, { latch: "closed_for_deletion" }),
    latch: "closed_for_deletion",
  },
  {
    name: "closeAll for the identity leaving",
    close: (f) => f.page.registry.closeAll(A, { latch: "closed_for_identity" }),
    latch: "closed_for_identity",
  },
  {
    name: "closeAll for an upgrade by a newer build",
    close: (f) => f.page.registry.closeAll(A, { latch: "upgrade_pending" }),
    latch: "upgrade_pending",
  },
  {
    // No connection is closed by it (nothing is registered yet in the early phases), the latch alone is set.
    name: "a latch set to deletion with no closeAll",
    close: (f) => f.page.registry.setLatch(A, "closed_for_deletion"),
    latch: "closed_for_deletion",
  },
];

const CLOSED = { kind: "refused", reason: "closed" } as const;

describe("R37: a closure ends the open's lifetime (openAccountData)", () => {
  for (const phase of OPEN_PHASES)
    for (const closure of CLOSURES)
      test(`${phase.name}, then ${closure.name}: the answer is \`closed\`, no service is published, the latch stays as the closure set it and no connection is kept`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const rt = f.runtime();
        const pending = rt.open(A);
        await g.reached;
        closure.close(f);
        g.release();
        expect(await pending).toEqual(CLOSED);
        await f.world.settle();
        expect(f.held(rt)).toEqual({ ...NOTHING, latch: closure.latch });
        expect(f.page.registry.openCount(A)).toBe(0);
        expect(f.calls.opens).toBe(phase.opens);
        rt.dispose();
      });

  test("another page deletes the database while the open's result is on its way: the closure of the versionchange ends the open", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    const rt = f.runtime();
    const pending = rt.open(A);
    await g.reached;
    expect(f.page.registry.openCount(A)).toBe(2);
    const other = f.world.page("W");
    const deleted = await f.world.run(other.host.delete(DB));
    expect(deleted).toMatch(/deleted/);
    g.release();
    expect(await pending).toEqual(CLOSED);
    await f.world.settle();
    expect(f.held(rt)).toEqual({ ...NOTHING, latch: "closed_for_deletion" });
    expect(f.world.idb.has(DB)).toBe(false);
    rt.dispose();
  });

  test("a closure of ANOTHER account says nothing about this open: it completes, lifts the latch and serves", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    const rt = f.runtime();
    const pending = rt.open(A);
    await g.reached;
    f.page.registry.closeAll(B, { latch: "closed_for_deletion" });
    g.release();
    expect(await pending).toMatchObject({ kind: "opened" });
    expect(f.held(rt)).toMatchObject({ connections: 2, service: true });
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.page.registry.latch(B)).toBe("closed_for_deletion");
    rt.dispose();
  });

  test("control: a NEW open begun after the closure is deliberately authorised: it lifts the latch and serves", async () => {
    const f = await setup();
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
    const rt = f.runtime();
    expect(await rt.open(A)).toMatchObject({ kind: "opened" });
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.held(rt)).toMatchObject({ connections: 2, service: true });
    rt.dispose();
  });

  test("control: a completed open that a closure then ends is ended as before (the service is gone, nothing is registered)", async () => {
    const f = await setup();
    const rt = f.runtime();
    expect((await rt.open(A)).kind).toBe("opened");
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    expect(rt.serviceFor(A)).toBeNull();
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
    rt.dispose();
  });

  test("a closure while the open is pending, then a NEW open of the same account in a healthy runtime: the new open lifts the latch and serves, and the old open's late result closes only its own handles and lifts nothing", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    const old = f.runtime();
    const pending = old.open(A);
    await g.reached;
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    const replacement = f.runtime();
    expect(await replacement.open(A)).toMatchObject({ kind: "opened" });
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.page.registry.openCount(A)).toBe(2);
    g.release();
    expect(await pending).toEqual(CLOSED);
    await f.world.settle();
    // Exactly the replacement's two connections remain, its service is live and the latch is the one its open lifted.
    expect(f.page.registry.openCount(A)).toBe(2);
    expect(f.page.registry.latch(A)).toBe("open");
    expect(replacement.serviceFor(A)?.live).toBe(true);
    expect(old.serviceFor(A)).toBeNull();
    old.dispose();
    replacement.dispose();
  });

  test("a runtime that was disposed AND whose open a closure ended answers `abandoned` (the caller has gone: the first fact)", async () => {
    const g = gate();
    const f = await setup({ holds: { landed: { 1: g } } });
    const rt = f.runtime();
    const pending = rt.open(A);
    await g.reached;
    rt.dispose();
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    g.release();
    expect(await pending).toEqual({ kind: "refused", reason: "abandoned" });
  });
});

describe("R37: openAccountData on its own (no runtime above it)", () => {
  for (const phase of OPEN_PHASES)
    for (const closure of CLOSURES)
      test(`${phase.name}, then ${closure.name}: the answer is \`closed\`, the open's own handles are let go and the latch stays as the closure set it`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const pending = openAccountData(f.openDeps, A, {});
        await g.reached;
        closure.close(f);
        g.release();
        expect(await pending).toEqual(CLOSED);
        expect(f.page.registry.openCount(A)).toBe(0);
        expect(f.page.registry.latch(A)).toBe(closure.latch);
        expect(f.calls.opens).toBe(phase.opens);
      });

  test("control: with no closure the open completes and lifts a latch that was set BEFORE it began", async () => {
    const f = await setup();
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    const outcome = await openAccountData(f.openDeps, A, {});
    expect(outcome.kind).toBe("opened");
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.page.registry.openCount(A)).toBe(2);
    if (outcome.kind === "opened") outcome.store.close();
  });
});

describe("R37: an opener that fails because a closure ended its lifetime (the real opener's reaction)", () => {
  test("the failure is the closure's consequence: the answer is `closed`, nothing is published and the latch stays as the closure set it", async () => {
    const g = gate();
    const f = await setup({
      holds: { landed: { 1: g } },
      failAfterLanded: true,
    });
    const rt = f.runtime();
    const pending = rt.open(A);
    await g.reached;
    f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
    g.release();
    // Recorded and then asserted: an open that REJECTS here is a wrong answer, not a crash of the test.
    const answer = await pending.then(
      (value) => value,
      (error: unknown) => ({ threw: String(error) }),
    );
    expect(answer).toEqual(CLOSED);
    await f.world.settle();
    expect(f.held(rt)).toEqual({ ...NOTHING, latch: "closed_for_deletion" });
    rt.dispose();
  });

  test("control: the same failure with NO closure is still a failure of the open: it is not turned into `closed`", async () => {
    const f = await setup({ failAfterLanded: true });
    const rt = f.runtime();
    await expect(rt.open(A)).rejects.toMatchObject({
      name: "StoreFailure",
      cause: "closed",
    });
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(f.page.registry.latch(A)).toBe("open");
    rt.dispose();
  });
});

describe("R37: a wipe's closure and the identity leaving together", () => {
  for (const kind of ["openAccountData", "a bare opener"] as const)
    test(`${kind}: the answer is \`closed\` and the wipe's latch is not replaced by the identity's`, async () => {
      const g = gate();
      const f = await setup({ holds: { landed: { 1: g } } });
      const rt = kind === "a bare opener" ? f.rawRuntime() : f.runtime();
      const pending = rt.open(A);
      await g.reached;
      f.page.registry.closeAll(A, { latch: "closed_for_deletion" });
      f.page.identity.account = null;
      f.identity.set(null);
      g.release();
      expect(await pending).toEqual(CLOSED);
      await f.world.settle();
      expect(f.page.registry.latch(A)).toBe("closed_for_deletion");
      expect(f.held(rt)).toMatchObject({ ...NOTHING });
      rt.dispose();
    });
});

describe("R37: the runtime holds the invariant on its own, over an opener that knows nothing of closures", () => {
  for (const phase of OPEN_PHASES.filter((p) => p.opens > 0))
    for (const closure of CLOSURES)
      test(`${phase.name}, then ${closure.name}: the runtime refuses \`closed\`, releases the store, publishes nothing and leaves the latch`, async () => {
        const g = gate();
        const f = await setup({ holds: phase.holds(g) });
        const rt = f.rawRuntime();
        const pending = rt.open(A);
        await g.reached;
        closure.close(f);
        g.release();
        expect(await pending).toEqual(CLOSED);
        await f.world.settle();
        expect(f.held(rt)).toEqual({ ...NOTHING, latch: closure.latch });
        expect(f.page.registry.openCount(A)).toBe(0);
        rt.dispose();
      });

  test("control: with no closure the bare opener's result is served", async () => {
    const f = await setup();
    const rt = f.rawRuntime();
    expect((await rt.open(A)).kind).toBe("opened");
    expect(f.held(rt)).toMatchObject({ connections: 2, service: true });
    rt.dispose();
  });

  test("a closure the runtime itself causes (its service ends on an identity change) does not end an open of the same account that began after it", async () => {
    const f = await setup();
    const rt = f.runtime();
    expect((await rt.open(A)).kind).toBe("opened");
    f.page.identity.account = B;
    f.identity.set({ account_id: B, epoch: 2, session_id: "s2" });
    expect(rt.serviceFor(A)).toBeNull();
    f.page.identity.account = A;
    f.identity.set({ account_id: A, epoch: 3, session_id: "s3" });
    expect(await rt.open(A)).toMatchObject({ kind: "opened" });
    expect(f.page.registry.latch(A)).toBe("open");
    expect(f.held(rt)).toMatchObject({ connections: 2, service: true });
    rt.dispose();
  });
});
